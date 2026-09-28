import GLib from 'gi://GLib?version=2.0';
import { isMatchPattern } from '~shared/match-pattern';
import { debug } from '../../core/debug';
import { writeText } from '../../core/files';
import type { ExtensionsService } from './extensions.service';
import type { ContentScriptEntry, RegisteredScript } from '~types/extensions';

const MAX_SCRIPTS = 500;

/**
 * Content scripts an extension registers while running (`chrome.scripting.registerContentScripts`),
 * kept in `dynamic-scripts.json` next to its files unless it asked not to persist them. They join the
 * manifest's own when a page loads, so a change reaches pages loaded afterwards.
 */
export class ExtensionScripts {
  private readonly scripts = new Map<string, RegisteredScript[]>();

  constructor(
    private readonly service: ExtensionsService,
    /** Called after any change, so open views can be given the new list. */
    private readonly changed: () => void,
  ) {}

  /** The registered scripts as manifest-style entries. */
  entries(id: string): ContentScriptEntry[] {
    return this.list(id).map((script) => ({
      matches: script.matches,
      exclude_matches: script.excludeMatches,
      js: script.js,
      css: script.css,
      all_frames: script.allFrames,
      run_at: script.runAt,
      world: script.world,
    }));
  }

  forget(id: string): void {
    this.scripts.delete(id);
  }

  register(id: string, scripts: RegisteredScript[]): void {
    const current = this.list(id);
    for (const script of scripts) {
      this.check(script);
      if (current.some((known) => known.id === script.id)) {
        throw new Error(`Duplicate script ID '${script.id}'`);
      }
    }
    if (current.length + scripts.length > MAX_SCRIPTS) throw new Error('Too many scripts.');
    this.scripts.set(id, [...current, ...scripts]);
    this.commit(id);
  }

  update(id: string, scripts: RegisteredScript[]): void {
    const current = this.list(id);
    for (const patch of scripts) {
      const index = current.findIndex((known) => known.id === patch.id);
      const known = current[index];
      if (known === undefined)
        throw new Error(`Content script with ID '${patch.id}' does not exist`);
      const merged = { ...known, ...patch };
      this.check(merged);
      current[index] = merged;
    }
    this.commit(id);
  }

  unregister(id: string, filter: { ids?: string[] }): void {
    const ids = filter.ids;
    this.scripts.set(
      id,
      this.list(id).filter((script) => ids !== undefined && !ids.includes(script.id)),
    );
    this.commit(id);
  }

  getRegistered(id: string, filter: { ids?: string[] }): RegisteredScript[] {
    const ids = filter.ids;
    return this.list(id).filter((script) => ids === undefined || ids.includes(script.id));
  }

  private check(script: RegisteredScript): void {
    if (typeof script.id !== 'string' || script.id === '' || script.id.startsWith('_')) {
      throw new Error('Content script ids must be non-empty and not start with an underscore.');
    }
    const files = [...(script.js ?? []), ...(script.css ?? [])];
    if (files.length === 0) throw new Error('Content script has no js or css.');
    if (files.some((file) => typeof file !== 'string' || file.includes('..'))) {
      throw new Error('Bad file name.');
    }
    const matches = script.matches ?? [];
    if (matches.length === 0 || !matches.every((pattern) => isMatchPattern(pattern))) {
      throw new Error('Content script matches are missing or not valid match patterns.');
    }
  }

  private list(id: string): RegisteredScript[] {
    let list = this.scripts.get(id);
    if (!list) {
      list = [];
      try {
        const [, bytes] = GLib.file_get_contents(this.service.dataFile(id, 'dynamic-scripts.json'));
        const saved = JSON.parse(new TextDecoder().decode(bytes)) as RegisteredScript[];
        if (Array.isArray(saved)) list = saved.filter((script) => typeof script.id === 'string');
      } catch {
        // Nothing registered before.
      }
      this.scripts.set(id, list);
    }
    return list;
  }

  private commit(id: string): void {
    const persistent = this.list(id).filter((script) => script.persistAcrossSessions !== false);
    writeText(this.service.dataFile(id, 'dynamic-scripts.json'), JSON.stringify(persistent)).catch(
      (error: unknown) => {
        debug('extensions', `could not save the scripts of ${id}: ${String(error)}`);
      },
    );
    this.changed();
  }
}
