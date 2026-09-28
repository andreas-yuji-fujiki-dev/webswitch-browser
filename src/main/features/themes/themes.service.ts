import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { parseTheme, slugify, themeCss } from '~shared/theme-format';
import { BUILTIN_THEMES, DARK_THEME, LIGHT_THEME, SYSTEM_THEME } from '~shared/themes-catalog';
import { debug } from '../../core/debug';
import { ensureDir, readText, removeTree, writeText } from '../../core/files';
import { configDir } from '../../core/paths';
import { isDark } from '../../core/theme';
import type { Unsubscribe } from '~types/common';
import type { ThemeChoiceFile, ThemeDefinition, ThemeResult, ThemesState } from '~types/themes';

Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');

const CHOICE_FILE = 'theme.json';
const THEMES_DIR = 'themes';
const MAX_FILE_BYTES = 64 * 1024;
const MAX_CUSTOM_THEMES = 100;

/**
 * The themes: the ones that ship with Webswitch, and the ones the user added, which live as JSON
 * files in `~/.config/webswitch/themes/` (so a theme can also be added by dropping a file there and
 * choosing Reload on the Themes page, or restarting). The choice is in `theme.json`. `system`
 * (the default) means Webswitch's dark or light theme, whichever the desktop uses.
 */
export class ThemesService {
  private readonly choicePath = GLib.build_filenamev([configDir(), CHOICE_FILE]);
  private readonly folder = GLib.build_filenamev([configDir(), THEMES_DIR]);
  private readonly custom = new Map<string, ThemeDefinition>();
  private active = SYSTEM_THEME;
  private busy: ThemesState['busy'] = null;
  private readonly listeners = new Set<(state: ThemesState) => void>();

  constructor() {
    try {
      const [, bytes] = GLib.file_get_contents(this.choicePath);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ThemeChoiceFile>;
      if (typeof parsed.active === 'string') this.active = parsed.active;
    } catch {
      // No choice yet: the system's.
    }
    this.loadFolder();
    if (this.active !== SYSTEM_THEME && this.find(this.active) === null) this.active = SYSTEM_THEME;
    // The desktop switching between light and dark matters while `system` is chosen.
    Gtk.Settings.get_default()?.connect('notify::gtk-interface-color-scheme', () => {
      if (this.active === SYSTEM_THEME) this.emit();
    });
  }

  /** The theme really on screen. */
  resolved(): ThemeDefinition {
    const chosen = this.active === SYSTEM_THEME ? null : this.find(this.active);
    if (chosen) return chosen;
    const fallback = this.find(isDark() ? DARK_THEME : LIGHT_THEME) ?? BUILTIN_THEMES[0];
    if (!fallback) throw new Error('No built-in themes');
    return fallback;
  }

  /** The stylesheet served as `webswitch://ui/theme.css`: only a comment for `system`, tokens.css has those. */
  css(): string {
    // Not empty: WebKit treats an empty answer from a custom scheme as a failed load.
    return this.active === SYSTEM_THEME
      ? '/* Automatic theme: tokens.css has the colors. */\n'
      : themeCss(this.resolved());
  }

  getState(): ThemesState {
    return {
      active: this.active,
      resolved: this.resolved().id,
      busy: this.busy,
      themes: [
        ...BUILTIN_THEMES.map((theme) => ({ ...theme, builtin: true })),
        ...[...this.custom.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((theme) => ({ ...theme, builtin: false })),
      ],
    };
  }

  onChanged(listener: (state: ThemesState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  select(id: unknown): ThemeResult {
    if (typeof id !== 'string' || (id !== SYSTEM_THEME && this.find(id) === null)) {
      return { ok: false, error: 'There is no such theme.' };
    }
    this.active = id;
    const file: ThemeChoiceFile = { version: 1, active: id };
    void writeText(this.choicePath, `${JSON.stringify(file)}\n`).catch((error: unknown) => {
      debug('themes', `could not save ${this.choicePath}: ${String(error)}`);
    });
    this.emit();
    return { ok: true, id };
  }

  /** Adds a theme from JSON text. The theme is kept as a file in the themes folder. */
  add(text: unknown): ThemeResult {
    if (typeof text !== 'string' || text.length > MAX_FILE_BYTES) {
      return { ok: false, error: 'A theme file is a small JSON text.' };
    }
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return { ok: false, error: 'That is not valid JSON.' };
    }
    if (this.custom.size >= MAX_CUSTOM_THEMES) {
      return { ok: false, error: `Remove a theme first: ${MAX_CUSTOM_THEMES} is the most.` };
    }
    const name =
      typeof input === 'object' &&
      input !== null &&
      'name' in input &&
      typeof input.name === 'string'
        ? input.name
        : '';
    const parsed = parseTheme(input, this.freeId(name));
    if (!parsed.ok) return parsed;
    const { theme } = parsed;
    this.custom.set(theme.id, theme);
    const stored = {
      name: theme.name,
      ...(theme.author ? { author: theme.author } : {}),
      ...(theme.license ? { license: theme.license } : {}),
      ...(theme.source ? { source: theme.source } : {}),
      scheme: theme.scheme,
      colors: theme.colors,
    };
    ensureDir(this.folder);
    void writeText(this.fileOf(theme.id), `${JSON.stringify(stored, null, 2)}\n`).catch(
      (error: unknown) => {
        debug('themes', `could not save ${theme.id}: ${String(error)}`);
      },
    );
    this.emit();
    return { ok: true, id: theme.id };
  }

  /** The extensions whose themes are here already (`openvsx:<publisher>.<name>`). */
  installedSources(): Set<string> {
    return new Set(
      [...this.custom.values()]
        .map((theme) => theme.source)
        .filter((s): s is string => s !== undefined),
    );
  }

  /** Shows what a bulk install is doing (or nothing, when it is over). */
  setBusy(busy: ThemesState['busy']): void {
    this.busy = busy;
    this.emit();
  }

  /** Adds the theme in a file the user picked. */
  async addFromFile(path: string): Promise<ThemeResult> {
    try {
      const info = await Gio.File.new_for_path(path).query_info_async(
        'standard::size',
        Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT,
        null,
      );
      if (info.get_size() > MAX_FILE_BYTES)
        return { ok: false, error: 'That file is too big for a theme.' };
    } catch {
      return { ok: false, error: 'That file cannot be read.' };
    }
    const text = await readText(path);
    return text === null ? { ok: false, error: 'That file cannot be read.' } : this.add(text);
  }

  /** Removes a theme that was added; the one in use falls back to the system's. */
  remove(id: unknown): ThemeResult {
    if (typeof id !== 'string' || !this.custom.has(id)) {
      return { ok: false, error: 'Only themes you added can be removed.' };
    }
    this.custom.delete(id);
    removeTree(this.fileOf(id));
    if (this.active === id) this.select(SYSTEM_THEME);
    else this.emit();
    return { ok: true, id };
  }

  /** Reads the themes folder again (a file was dropped in by hand). */
  reload(): void {
    this.custom.clear();
    this.loadFolder();
    if (this.active !== SYSTEM_THEME && this.find(this.active) === null) this.active = SYSTEM_THEME;
    this.emit();
  }

  private find(id: string): ThemeDefinition | null {
    return BUILTIN_THEMES.find((theme) => theme.id === id) ?? this.custom.get(id) ?? null;
  }

  private fileOf(id: string): string {
    return GLib.build_filenamev([this.folder, `${id}.json`]);
  }

  /** A theme id from its name that no other theme has. */
  private freeId(name: string): string {
    const base = slugify(name);
    let id = base;
    for (let n = 2; this.find(id) !== null; n++) id = `${base}-${n}`;
    return id;
  }

  private loadFolder(): void {
    if (!GLib.file_test(this.folder, GLib.FileTest.IS_DIR)) return;
    try {
      const dir = GLib.Dir.open(this.folder, 0);
      for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
        if (!name.endsWith('.json') || this.custom.size >= MAX_CUSTOM_THEMES) continue;
        try {
          const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([this.folder, name]));
          if (bytes.length > MAX_FILE_BYTES) continue;
          const id = slugify(name.slice(0, -'.json'.length));
          if (BUILTIN_THEMES.some((theme) => theme.id === id)) continue;
          const parsed = parseTheme(JSON.parse(new TextDecoder().decode(bytes)), id);
          if (parsed.ok) this.custom.set(id, parsed.theme);
        } catch {
          // A file that is not a theme is left alone.
        }
      }
    } catch {
      // No folder to read.
    }
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
