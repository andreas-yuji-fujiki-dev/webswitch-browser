import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import WebKit from 'gi://WebKit?version=6.0';
import { dnrToContentBlocker } from '~shared/dnr';
import { navigationVerdict } from '~shared/dnr-redirect';
import { debug } from '../../core/debug';
import { ensureDir, writeText } from '../../core/files';
import { cacheDir } from '../../core/paths';
import type { ExtensionsService } from './extensions.service';
import type {
  BlockerRule,
  DnrRule,
  DnrState,
  ExtensionCall,
  LoadedExtension,
  NavigationVerdict,
} from '~types/extensions';

Gio._promisify(WebKit.UserContentFilterStore.prototype, 'save', 'save_finish');

// WebKit accepts 150,000 rules in one content blocker.
const MAX_RULES_PER_FILTER = 150_000;
const RECOMPILE_DELAY_MS = 300;
const MAX_DYNAMIC_RULES = 30_000;

/**
 * Network blocking rules of Manifest V3 extensions (declarativeNetRequest): the static rulesets of the
 * manifest (each can be turned on and off), the extension's dynamic rules (kept in `dnr-state.json`)
 * and its session rules (kept in memory). Together they become WebKit content blockers, which the
 * runtime puts into every tab. An allow rule only cancels rules in the same blocker, so an extension
 * with more than 150,000 rules loses that across the split.
 */
export class ExtensionDnr {
  private readonly states = new Map<string, DnrState>();
  private readonly session = new Map<string, DnrRule[]>();
  private readonly filters = new Map<string, WebKit.UserContentFilter[]>();
  private readonly timers = new Map<string, number>();
  /** Every rule of an extension that is on (static, dynamic, session): navigations are checked against these. */
  private readonly allRules = new Map<string, DnrRule[]>();
  /** A checksum of the last rule set actually compiled: an extension that keeps re-sending the
   *  same rules (Ghostery does, on every navigation) must not pay for a real WebKit compile again. */
  private readonly compiledHash = new Map<string, string>();
  private store: WebKit.UserContentFilterStore | null = null;

  constructor(
    private readonly service: ExtensionsService,
    private readonly readSource: (extension: LoadedExtension, path: string) => string | null,
    /** Called when the compiled blockers of an extension changed. */
    private readonly changed: () => void,
  ) {}

  filtersOf(id: string): WebKit.UserContentFilter[] {
    return this.filters.get(id) ?? [];
  }

  /** Compiles what is not compiled yet, and forgets extensions that are no longer active. */
  async sync(active: LoadedExtension[]): Promise<void> {
    const ids = new Set(active.map((extension) => extension.summary.id));
    for (const id of [...this.filters.keys()]) if (!ids.has(id)) this.filters.delete(id);
    for (const extension of active) {
      if (!this.filters.has(extension.summary.id)) await this.compile(extension);
    }
  }

  /** What this extension's rules say about a page that is about to load (redirect, block, allow, or nothing). */
  navigationVerdict(
    id: string,
    url: string,
    type: 'main_frame' | 'sub_frame',
    base: string,
  ): NavigationVerdict {
    return navigationVerdict(this.allRules.get(id) ?? [], url, type, base);
  }

  forget(id: string): void {
    this.allRules.delete(id);
    this.states.delete(id);
    this.session.delete(id);
    this.filters.delete(id);
  }

  async handle(extension: LoadedExtension, call: ExtensionCall): Promise<unknown> {
    const permissions = extension.manifest.permissions ?? [];
    if (
      !permissions.includes('declarativeNetRequest') &&
      !permissions.includes('declarativeNetRequestWithHostAccess')
    ) {
      throw new Error("The extension did not ask for the 'declarativeNetRequest' permission.");
    }
    const { id } = extension.summary;
    const options = (call.options ?? {}) as {
      addRules?: DnrRule[];
      removeRuleIds?: number[];
      enableRulesetIds?: string[];
      disableRulesetIds?: string[];
    };
    const state = this.stateOf(id);
    switch (call.op) {
      case 'dnr.getDynamic':
        return state.dynamic;
      case 'dnr.getSession':
        return this.session.get(id) ?? [];
      case 'dnr.updateDynamic':
        state.dynamic = this.merge(state.dynamic, options);
        await this.save(id, state);
        this.schedule(extension);
        return undefined;
      case 'dnr.updateSession':
        this.session.set(id, this.merge(this.session.get(id) ?? [], options));
        this.schedule(extension);
        return undefined;
      case 'dnr.getEnabledRulesets':
        return this.enabledRulesets(extension, state);
      case 'dnr.updateEnabledRulesets': {
        const enabled = new Set(this.enabledRulesets(extension, state));
        for (const ruleset of options.disableRulesetIds ?? []) enabled.delete(ruleset);
        for (const ruleset of options.enableRulesetIds ?? []) {
          if (!this.resources(extension).some((resource) => resource.id === ruleset)) {
            throw new Error(`Rule resource with id ${ruleset} does not exist.`);
          }
          enabled.add(ruleset);
        }
        state.enabledRulesets = [...enabled];
        await this.save(id, state);
        this.schedule(extension);
        return undefined;
      }
      default:
        throw new Error(`chrome API '${call.op}' is not available in Webswitch.`);
    }
  }

  private merge(
    current: DnrRule[],
    options: { addRules?: DnrRule[]; removeRuleIds?: number[] },
  ): DnrRule[] {
    const removed = new Set(options.removeRuleIds ?? []);
    const kept = current.filter((rule) => rule.id === undefined || !removed.has(rule.id));
    const known = new Set(kept.map((rule) => rule.id));
    for (const rule of options.addRules ?? []) {
      if (typeof rule.id !== 'number' || known.has(rule.id)) {
        throw new Error(`Rule with id ${String(rule.id)} does not have a unique ID.`);
      }
      known.add(rule.id);
    }
    const next = [...kept, ...(options.addRules ?? [])];
    if (next.length > MAX_DYNAMIC_RULES) throw new Error('Too many rules.');
    return next;
  }

  private resources(
    extension: LoadedExtension,
  ): { id?: string; enabled?: boolean; path?: string }[] {
    return extension.manifest.declarative_net_request?.rule_resources ?? [];
  }

  private enabledRulesets(extension: LoadedExtension, state: DnrState): string[] {
    return (
      state.enabledRulesets ??
      this.resources(extension)
        .filter((resource) => resource.enabled === true)
        .map((resource) => resource.id ?? '')
    );
  }

  private stateOf(id: string): DnrState {
    let state = this.states.get(id);
    if (!state) {
      state = { enabledRulesets: null, dynamic: [] };
      try {
        const [, bytes] = GLib.file_get_contents(this.service.dataFile(id, 'dnr-state.json'));
        state = { ...state, ...(JSON.parse(new TextDecoder().decode(bytes)) as Partial<DnrState>) };
      } catch {
        // Nothing changed before.
      }
      this.states.set(id, state);
    }
    return state;
  }

  private save(id: string, state: DnrState): Promise<void> {
    return writeText(this.service.dataFile(id, 'dnr-state.json'), JSON.stringify(state));
  }

  /** Extensions change their rules in bursts; one compile follows the last change. */
  private schedule(extension: LoadedExtension): void {
    const { id } = extension.summary;
    const pending = this.timers.get(id);
    if (pending !== undefined) GLib.source_remove(pending);
    this.timers.set(
      id,
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, RECOMPILE_DELAY_MS, () => {
        this.timers.delete(id);
        void this.compile(extension).then(() => {
          this.changed();
        });
        return GLib.SOURCE_REMOVE;
      }),
    );
  }

  private async attempt(name: string, rules: BlockerRule[]): Promise<WebKit.UserContentFilter> {
    const json = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(rules)));
    if (!this.store) throw new Error('No filter store.');
    return await this.store.save(name, json, null);
  }

  /** Which rules of a list WebKit cannot read, found by halving (only runs when a list is refused). */
  private async unreadable(name: string, rules: BlockerRule[]): Promise<Set<BlockerRule>> {
    if (rules.length === 0) return new Set();
    try {
      await this.attempt(`${name}-probe`, rules);
      return new Set();
    } catch {
      if (rules.length === 1) return new Set(rules);
      const middle = Math.floor(rules.length / 2);
      const left = await this.unreadable(name, rules.slice(0, middle));
      const right = await this.unreadable(name, rules.slice(middle));
      return new Set([...left, ...right]);
    }
  }

  /** Compiles a list; if WebKit refuses it, leaves out the rules it cannot read and compiles the rest. */
  private async compileList(name: string, rules: BlockerRule[]): Promise<WebKit.UserContentFilter> {
    try {
      return await this.attempt(name, rules);
    } catch {
      const bad = await this.unreadable(name, rules);
      debug('extensions', `${name}: ${String(bad.size)} rules WebKit cannot read were left out`);
      return await this.attempt(
        name,
        rules.filter((rule) => !bad.has(rule)),
      );
    }
  }

  private async compile(extension: LoadedExtension): Promise<void> {
    const { id } = extension.summary;
    const state = this.stateOf(id);
    const enabled = new Set(this.enabledRulesets(extension, state));
    const rules: DnrRule[] = [];
    for (const resource of this.resources(extension)) {
      if (!enabled.has(resource.id ?? '') || typeof resource.path !== 'string') continue;
      const text = this.readSource(extension, resource.path);
      if (text === null) continue;
      try {
        rules.push(...(JSON.parse(text) as DnrRule[]));
      } catch {
        debug('extensions', `${id}: ${resource.path} is not valid JSON`);
      }
    }
    rules.push(...state.dynamic, ...(this.session.get(id) ?? []));
    this.allRules.set(id, rules);
    // Compiling is expensive (a real WebKit content-filter build, worse when rules need the
    // unreadable-pattern recovery below); an extension that calls updateDynamicRules with the same
    // rules on every page (observed: Ghostery, ~15 s per compile of its ~41,000 rules) must not
    // redo that work when nothing actually changed.
    const serialized = JSON.stringify(rules);
    const hash = `${String(rules.length)}:${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, serialized, -1)}`;
    if (this.compiledHash.get(id) === hash && this.filters.has(id)) {
      debug('extensions', `${id}: rules are unchanged, not recompiling`);
      return;
    }
    this.compiledHash.set(id, hash);
    const converted = dnrToContentBlocker(rules).rules;
    const filters: WebKit.UserContentFilter[] = [];
    if (converted.length > 0) {
      const directory = GLib.build_filenamev([cacheDir(), 'extension-filters']);
      ensureDir(directory);
      this.store ??= WebKit.UserContentFilterStore.new(directory);
      try {
        for (
          let start = 0, part = 0;
          start < converted.length;
          start += MAX_RULES_PER_FILTER, part++
        ) {
          const chunk = converted.slice(start, start + MAX_RULES_PER_FILTER);
          filters.push(await this.compileList(`${id}-${String(part)}`, chunk));
        }
        debug(
          'extensions',
          `${id}: ${String(converted.length)} blocking rules from ${String(rules.length)} rules`,
        );
      } catch (error) {
        debug('extensions', `${id}: the rules could not be compiled: ${String(error)}`);
      }
    }
    this.filters.set(id, filters);
  }
}
