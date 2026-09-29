import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import { convertVsCodeTheme, mergeIncluded, parseJsonc } from '~shared/vscode-theme';
import { debug } from '../../core/debug';
import { ensureDir, removeTree } from '../../core/files';
import type { Http } from '../../core/http';
import { cacheDir } from '../../core/paths';
import type { ThemesService } from './themes.service';
import type {
  VsxExtensionResponse,
  VsxInstallResult,
  VsxManifest,
  VsxSearchAnswer,
  VsxSearchResponse,
  VsxSort,
} from '~types/themes';

Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async', 'wait_check_finish');

// Open VSX is the open registry of VS Code extensions (Microsoft's Marketplace may only be used by
// Microsoft's own products). Nothing is asked from it until the user searches or installs.
const API = 'https://open-vsx.org/api/';
const PAGE = 20;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const MAX_VSIX_BYTES = 40_000_000;
const MAX_THEME_BYTES = 3_000_000;
const MAX_THEMES_PER_EXTENSION = 40;
const MAX_INCLUDE_DEPTH = 4;
const SORTS: readonly VsxSort[] = ['relevance', 'downloadCount', 'averageRating', 'timestamp'];

/** A path from inside an extension, resolved against `base`; null when it would leave `root`. */
function resolveInside(root: string, base: string, relative: string): string | null {
  const parts = GLib.build_filenamev([base, relative]).split('/');
  const kept: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') kept.pop();
    else kept.push(part);
  }
  const resolved = `/${kept.join('/')}`;
  return resolved.startsWith(`${root}/`) ? resolved : null;
}

/** Searches Open VSX for color themes and turns the ones the user picks into Webswitch themes. */
export class OpenVsx {
  constructor(
    private readonly http: Http,
    private readonly themes: ThemesService,
  ) {}

  async search(query: unknown, offset: unknown, sort: unknown): Promise<VsxSearchAnswer> {
    const text = typeof query === 'string' ? query.trim().slice(0, 100) : '';
    const start =
      typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const order = SORTS.find((candidate) => candidate === sort) ?? 'downloadCount';
    const url = `${API}-/search?category=Themes&query=${encodeURIComponent(text)}&size=${String(PAGE)}&offset=${String(start)}&sortBy=${order}&sortOrder=desc`;
    const answer = await this.http.json<VsxSearchResponse>(url, 4_000_000);
    const have = this.themes.installedSources();
    return {
      total: answer.totalSize ?? 0,
      results: (answer.extensions ?? [])
        .filter((item) => NAME.test(item.namespace ?? '') && NAME.test(item.name ?? ''))
        .map((item) => {
          const namespace = item.namespace ?? '';
          const name = item.name ?? '';
          return {
            id: `${namespace}.${name}`,
            namespace,
            name,
            displayName: item.displayName ?? name,
            description: (item.description ?? '').slice(0, 200),
            downloads: item.downloadCount ?? 0,
            rating: typeof item.averageRating === 'number' ? item.averageRating : null,
            version: item.version ?? '',
            installed: have.has(`openvsx:${namespace}.${name}`),
          };
        }),
    };
  }

  /** Downloads an extension, checks it against Open VSX's checksum and adds every color theme in it. */
  async install(namespace: unknown, name: unknown): Promise<VsxInstallResult> {
    if (
      typeof namespace !== 'string' ||
      typeof name !== 'string' ||
      !NAME.test(namespace) ||
      !NAME.test(name)
    ) {
      return { ok: false, error: 'That is not an extension name.' };
    }
    const work = GLib.build_filenamev([
      cacheDir(),
      'vsx',
      `${namespace}.${name}-${String(GLib.get_monotonic_time())}`,
    ]);
    try {
      const details = await this.http.json<VsxExtensionResponse>(
        `${API}${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
        2_000_000,
      );
      const download = details.files?.download;
      if (
        !download?.startsWith(`${API}${namespace}/${name}/`) ||
        !VERSION.test(details.version ?? '')
      ) {
        return { ok: false, error: 'Open VSX answered with something unexpected.' };
      }
      ensureDir(work);
      const archive = GLib.build_filenamev([work, 'extension.vsix']);
      const sha256 = await this.http.download(download, archive, MAX_VSIX_BYTES, () => undefined);
      const published = details.files?.sha256
        ? (await this.http.text(details.files.sha256, 1000)).trim().split(/\s+/)[0]
        : undefined;
      if (published !== undefined && published !== sha256) {
        return { ok: false, error: 'The download does not match the checksum Open VSX published.' };
      }
      const unpacked = GLib.build_filenamev([work, 'files']);
      ensureDir(unpacked);
      await Gio.Subprocess.new(
        ['unzip', '-q', archive, 'extension/*', '-d', unpacked],
        Gio.SubprocessFlags.STDERR_SILENCE,
      ).wait_check_async(null);
      const extension = GLib.build_filenamev([unpacked, 'extension']);
      const manifest = JSON.parse(
        this.read(GLib.build_filenamev([extension, 'package.json']), 2_000_000),
      ) as VsxManifest;
      const entries = (manifest.contributes?.themes ?? []).slice(0, MAX_THEMES_PER_EXTENSION);
      if (entries.length === 0) {
        return {
          ok: false,
          error: 'This extension has no color themes in it (it may be an icon theme).',
        };
      }
      const added: string[] = [];
      for (const entry of entries) {
        if (typeof entry.path !== 'string') continue;
        const file = resolveInside(extension, extension, entry.path);
        if (file === null) continue;
        try {
          const chain = this.loadChain(extension, file, 0);
          const merged = mergeIncluded(chain);
          const converted = convertVsCodeTheme(merged, entry.label ?? '', entry.uiTheme);
          const result = this.themes.add(
            JSON.stringify({
              ...converted,
              author: namespace,
              license: details.license ?? 'unknown license',
              source: `openvsx:${namespace}.${name}`,
            }),
          );
          if (result.ok) added.push(converted.name as string);
        } catch (error) {
          debug('themes', `skipped ${entry.path}: ${String(error)}`);
        }
      }
      return added.length > 0
        ? { ok: true, added }
        : { ok: false, error: 'None of the themes in it could be read.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug('themes', `installing ${namespace}.${name} failed: ${message}`);
      return { ok: false, error: message };
    } finally {
      removeTree(work);
    }
  }

  /** The `count` most downloaded themes not installed yet; ones that fail (icon themes) are skipped. */
  async installPopular(count: unknown): Promise<VsxInstallResult> {
    const wanted =
      typeof count === 'number' && Number.isInteger(count) ? Math.min(60, Math.max(1, count)) : 25;
    const added: string[] = [];
    let installed = 0;
    let tried = 0;
    this.themes.setBusy({ text: 'Looking for the most popular themes…', done: 0, total: wanted });
    try {
      for (let offset = 0; installed < wanted && offset < PAGE * 8; offset += PAGE) {
        const page = await this.search('', offset, 'downloadCount');
        if (page.results.length === 0) break;
        for (const item of page.results) {
          if (installed >= wanted) break;
          if (item.installed) continue;
          tried++;
          this.themes.setBusy({
            text: `Installing ${item.displayName}…`,
            done: installed,
            total: wanted,
          });
          const result = await this.install(item.namespace, item.name);
          if (result.ok) {
            installed++;
            added.push(...result.added);
          }
        }
      }
      return added.length > 0
        ? { ok: true, added }
        : { ok: false, error: `Nothing could be installed (${String(tried)} tried).` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.themes.setBusy(null);
    }
  }

  private read(path: string, limit: number): string {
    const [, bytes] = GLib.file_get_contents(path);
    if (bytes.length > limit) throw new Error('A file in the extension is too big.');
    return new TextDecoder().decode(bytes);
  }

  /** A theme file and the files it includes, the one asked for first. */
  private loadChain(
    root: string,
    file: string,
    depth: number,
  ): { colors?: Record<string, unknown>; type?: unknown; name?: unknown; include?: unknown }[] {
    const theme = parseJsonc(this.read(file, MAX_THEME_BYTES)) as {
      colors?: Record<string, unknown>;
      type?: unknown;
      name?: unknown;
      include?: unknown;
    };
    if (typeof theme.include !== 'string' || depth >= MAX_INCLUDE_DEPTH) return [theme];
    const parent = resolveInside(root, GLib.path_get_dirname(file), theme.include);
    return parent === null ? [theme] : [theme, ...this.loadChain(root, parent, depth + 1)];
  }
}
