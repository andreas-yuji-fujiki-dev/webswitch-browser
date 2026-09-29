import GLib from 'gi://GLib?version=2.0';
import { isMatchPattern } from '~shared/match-pattern';
import { debug } from '../../core/debug';
import { writeText } from '../../core/files';
import type { ExtensionsService } from './extensions.service';
import type {
  ExtensionCall,
  LoadedExtension,
  UserScriptEntry,
  UserScriptWorld,
} from '~types/extensions';

const MAX_SCRIPTS = 1000;
const MAX_CODE_BYTES = 8_000_000;

/**
 * `chrome.userScripts`: scripts an extension (Tampermonkey, Violentmonkey ...) keeps for the sites
 * it names, run in a world of their own apart from the page and from the extension's content
 * scripts. The extension's own code decides what they may do; when it turned messaging on for that
 * world a script can send messages to the extension (`runtime.onUserScriptMessage`). Kept in
 * `user-scripts.json` next to the extension's files.
 */
export class ExtensionUserScripts {
  private readonly scripts = new Map<string, UserScriptEntry[]>();
  private readonly worlds = new Map<string, UserScriptWorld>();

  constructor(
    private readonly service: ExtensionsService,
    /** Called after any change, so open pages can be given the new list. */
    private readonly changed: () => void,
  ) {}

  entries(id: string): UserScriptEntry[] {
    return this.load(id).scripts;
  }

  world(id: string): UserScriptWorld {
    return this.load(id).world;
  }

  forget(id: string): void {
    this.scripts.delete(id);
    this.worlds.delete(id);
  }

  handle(extension: LoadedExtension, call: ExtensionCall): unknown {
    if (!(extension.manifest.permissions ?? []).includes('userScripts')) {
      throw new Error("The extension did not ask for the 'userScripts' permission.");
    }
    const { id } = extension.summary;
    const state = this.load(id);
    const given = (call.scripts ?? []) as UserScriptEntry[];
    switch (call.op) {
      case 'userScripts.register':
        for (const script of given) {
          this.check(extension, script);
          if (state.scripts.some((known) => known.id === script.id)) {
            throw new Error(`Duplicate script ID '${script.id}'`);
          }
        }
        if (state.scripts.length + given.length > MAX_SCRIPTS) throw new Error('Too many scripts.');
        state.scripts.push(...given);
        this.commit(id);
        return undefined;
      case 'userScripts.update':
        for (const patch of given) {
          const index = state.scripts.findIndex((known) => known.id === patch.id);
          const known = state.scripts[index];
          if (known === undefined) throw new Error(`Script with ID '${patch.id}' does not exist.`);
          const merged = { ...known, ...patch };
          this.check(extension, merged);
          state.scripts[index] = merged;
        }
        this.commit(id);
        return undefined;
      case 'userScripts.unregister': {
        const ids = (call.filter as { ids?: string[] }).ids;
        state.scripts = state.scripts.filter(
          (script) => ids !== undefined && !ids.includes(script.id),
        );
        this.scripts.set(id, state.scripts);
        this.commit(id);
        return undefined;
      }
      case 'userScripts.getScripts': {
        const ids = (call.filter as { ids?: string[] }).ids;
        return state.scripts.filter((script) => ids === undefined || ids.includes(script.id));
      }
      case 'userScripts.configureWorld': {
        const options = (call.options ?? {}) as { messaging?: boolean; csp?: string };
        state.world = { messaging: options.messaging === true, csp: options.csp };
        this.worlds.set(id, state.world);
        this.commit(id);
        return undefined;
      }
      case 'userScripts.getWorldConfigurations':
        return [{ ...state.world }];
      case 'userScripts.resetWorldConfiguration':
        state.world = { messaging: false };
        this.worlds.set(id, state.world);
        this.commit(id);
        return undefined;
      default:
        throw new Error(`chrome API '${call.op}' is not available in Webswitch.`);
    }
  }

  private check(extension: LoadedExtension, script: UserScriptEntry): void {
    if (typeof script.id !== 'string' || script.id === '' || script.id.startsWith('_')) {
      throw new Error('User script ids must be non-empty and not start with an underscore.');
    }
    const matches = script.matches ?? [];
    if (matches.length === 0 || !matches.every((pattern) => isMatchPattern(pattern))) {
      throw new Error('User script matches are missing or not valid match patterns.');
    }
    const sources = script.js ?? [];
    if (sources.length === 0) throw new Error('User script has no js.');
    let size = 0;
    for (const source of sources) {
      if (typeof source.code === 'string') size += source.code.length;
      else if (typeof source.file === 'string') {
        if (source.file.includes('..')) throw new Error('Bad file name.');
        try {
          GLib.file_get_contents(GLib.build_filenamev([extension.files, source.file]));
        } catch {
          throw new Error(`Could not load file '${source.file}'.`);
        }
      } else throw new Error('A user script source needs code or file.');
    }
    if (size > MAX_CODE_BYTES) throw new Error('User script is too large.');
  }

  private load(id: string): { scripts: UserScriptEntry[]; world: UserScriptWorld } {
    let scripts = this.scripts.get(id);
    let world = this.worlds.get(id);
    if (!scripts || !world) {
      scripts = [];
      world = { messaging: false };
      try {
        const [, bytes] = GLib.file_get_contents(this.service.dataFile(id, 'user-scripts.json'));
        const saved = JSON.parse(new TextDecoder().decode(bytes)) as {
          scripts?: UserScriptEntry[];
          world?: UserScriptWorld;
        };
        if (Array.isArray(saved.scripts)) scripts = saved.scripts;
        if (saved.world) world = saved.world;
      } catch {
        // Nothing registered before.
      }
      this.scripts.set(id, scripts);
      this.worlds.set(id, world);
    }
    return { scripts, world };
  }

  private commit(id: string): void {
    const state = this.load(id);
    writeText(
      this.service.dataFile(id, 'user-scripts.json'),
      JSON.stringify({ scripts: state.scripts, world: state.world }),
    ).catch((error: unknown) => {
      debug('extensions', `could not save the user scripts of ${id}: ${String(error)}`);
    });
    this.changed();
  }
}
