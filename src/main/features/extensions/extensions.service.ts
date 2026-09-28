import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import { extensionIdFrom, extensionIdFromInput, parseCrx } from '~shared/crx';
import { summarize, validateManifest } from '~shared/extension-manifest';
import { parseJsonc } from '~shared/vscode-theme';
import { debug } from '../../core/debug';
import { ensureDir, removeTree, writeText } from '../../core/files';
import type { Http } from '../../core/http';
import { cacheDir, dataDir } from '../../core/paths';
import type { Unsubscribe } from '~types/common';
import type {
  ActionState,
  ExtensionManifest,
  ExtensionMeta,
  ExtensionResult,
  ExtensionsState,
  ExtensionSummary,
  InstalledExtension,
  LoadedExtension,
} from '~types/extensions';

Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async', 'wait_check_finish');

const MAX_CRX_BYTES = 80_000_000;
const MAX_ICON_BYTES = 300_000;
const MAX_MANIFEST_BYTES = 1_000_000;
// The address every Chromium-based browser asks for an extension by id (the Web Store's update service).
const STORE = 'https://clients2.google.com/service/update2/crx';
const PRODUCT_VERSION = '150.0.0.0';

/** Chrome's `__MSG_key__` text in a manifest, looked up in the extension's own translations. */
function translate(text: string, messages: Record<string, { message?: string }>): string {
  const found = /^__MSG_(\w+)__$/.exec(text);
  return found
    ? (messages[(found[1] ?? '').toLowerCase()]?.message ??
        messages[found[1] ?? '']?.message ??
        text)
    : text;
}

/**
 * The extensions installed here, kept under `~/.local/share/webswitch/extensions/<id>/` (`files/` holds
 * the unpacked extension, `meta.json` whether it is on, `storage.json` what it keeps with
 * chrome.storage). Nothing is fetched until the user asks: Install downloads the package from the
 * Chrome Web Store's update service, checks it is the extension that was asked for, and waits for the
 * user to confirm what it may do before anything is kept.
 */
export class ExtensionsService {
  private readonly root = GLib.build_filenamev([dataDir(), 'extensions']);
  private readonly installed = new Map<string, LoadedExtension>();
  private pending: { summary: ExtensionSummary; work: string; source: 'store' | 'folder' } | null =
    null;
  private busy: string | null = null;
  private readonly actions = new Map<string, ActionState>();
  private proxyChoice: { extension: string; description: string } | null = null;
  private readonly fresh = new Map<string, 'install' | 'update'>();
  private readonly listeners = new Set<(state: ExtensionsState) => void>();

  constructor(
    private readonly http: Http,
    /** The General settings switch. */
    private readonly allowed: () => boolean,
  ) {
    this.load();
  }

  onChanged(listener: (state: ExtensionsState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): ExtensionsState {
    return {
      enabled: this.allowed(),
      extensions: [...this.installed.values()]
        .sort((a, b) => a.summary.name.localeCompare(b.summary.name))
        .map((extension): InstalledExtension => ({
          ...extension.summary,
          enabled: extension.meta.enabled,
          source: extension.meta.source,
          badge: this.action(extension.summary.id).badge,
          badgeColor: this.action(extension.summary.id).badgeColor,
          title: this.action(extension.summary.id).title,
          actionIcon: this.action(extension.summary.id).icon,
        })),
      pending: this.pending?.summary ?? null,
      proxy: this.proxyChoice
        ? {
            extension: this.proxyChoice.extension,
            name: this.installed.get(this.proxyChoice.extension)?.summary.name ?? '',
            description: this.proxyChoice.description,
          }
        : null,
      busy: this.busy,
    };
  }

  /** The extensions that are on (none while the General settings switch is off). */
  active(): LoadedExtension[] {
    return this.allowed()
      ? [...this.installed.values()].filter((extension) => extension.meta.enabled)
      : [];
  }

  get(id: string): LoadedExtension | undefined {
    return this.installed.get(id);
  }

  /** The General settings switch changed: whoever shows the state must hear about it. */
  settingsChanged(): void {
    this.emit();
  }

  /** An extension is sending pages through a proxy (or stopped): the page and the toolbar say so. */
  setProxy(choice: { extension: string; description: string } | null): void {
    this.proxyChoice = choice;
    this.emit();
  }

  /** What the extension changed about its toolbar button. */
  action(id: string): ActionState {
    return (
      this.actions.get(id) ?? { badge: '', badgeColor: '', title: '', icon: null, popup: null }
    );
  }

  setAction(id: string, patch: Partial<ActionState>): void {
    const next = { ...this.action(id), ...patch };
    next.badge = next.badge.slice(0, 4);
    this.actions.set(id, next);
    this.emit();
  }

  /** `install` or `update` once, right after the user added the extension (for `runtime.onInstalled`). */
  takeFresh(id: string): 'install' | 'update' | null {
    const reason = this.fresh.get(id) ?? null;
    this.fresh.delete(id);
    return reason;
  }

  /** A file of the extension's own data (not its code): `storage.json`, `dynamic-scripts.json`. */
  dataFile(id: string, name: string): string {
    return GLib.build_filenamev([this.root, id, name]);
  }

  /** The user agreed to more permissions (asked for at run time): they count from now on and stay. */
  async grant(id: string, permissions: string[], origins: string[]): Promise<void> {
    const extension = this.installed.get(id);
    if (!extension) return;
    this.applyGrant(extension.manifest, permissions, origins);
    const path = this.dataFile(id, 'granted.json');
    let saved: { permissions: string[]; origins: string[] } = { permissions: [], origins: [] };
    try {
      const [, bytes] = GLib.file_get_contents(path);
      saved = JSON.parse(new TextDecoder().decode(bytes)) as typeof saved;
    } catch {
      // Nothing granted before.
    }
    saved.permissions = [...new Set([...saved.permissions, ...permissions])];
    saved.origins = [...new Set([...saved.origins, ...origins])];
    await writeText(path, JSON.stringify(saved));
  }

  /** Takes back permissions the extension asked for at run time (the ones in its manifest stay). */
  async revoke(id: string, permissions: string[], origins: string[]): Promise<void> {
    const extension = this.installed.get(id);
    if (!extension) return;
    const { manifest } = extension;
    const optional = new Set(manifest.optional_permissions ?? []);
    const optionalHosts = new Set(manifest.optional_host_permissions ?? []);
    manifest.permissions = (manifest.permissions ?? []).filter(
      (item) => !permissions.includes(item) || !optional.has(item),
    );
    manifest.host_permissions = (manifest.host_permissions ?? []).filter(
      (item) => !origins.includes(item) || !optionalHosts.has(item),
    );
    const path = this.dataFile(id, 'granted.json');
    try {
      const [, bytes] = GLib.file_get_contents(path);
      const saved = JSON.parse(new TextDecoder().decode(bytes)) as {
        permissions: string[];
        origins: string[];
      };
      saved.permissions = saved.permissions.filter((item) => !permissions.includes(item));
      saved.origins = saved.origins.filter((item) => !origins.includes(item));
      await writeText(path, JSON.stringify(saved));
    } catch {
      // Nothing was saved.
    }
  }

  private applyGrant(manifest: ExtensionManifest, permissions: string[], origins: string[]): void {
    manifest.permissions = [...new Set([...(manifest.permissions ?? []), ...permissions])];
    manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ...origins])];
  }

  /** Where an extension keeps what chrome.storage.local holds. */
  storagePath(id: string): string {
    return GLib.build_filenamev([this.root, id, 'storage.json']);
  }

  /** Downloads an extension from the Web Store and waits for the user to confirm it. */
  async prepareFromStore(input: unknown): Promise<ExtensionResult> {
    if (!this.allowed())
      return { ok: false, error: 'Turn extensions on in General settings first.' };
    const id = typeof input === 'string' ? extensionIdFromInput(input) : null;
    if (id === null) {
      return {
        ok: false,
        error: 'That is not a Chrome Web Store address or extension id (32 letters, a to p).',
      };
    }
    return this.prepare((work) => this.downloadStorePackage(id, work), 'store');
  }

  /** Loads an unpacked extension from a folder (for developers) and waits for the user to confirm it. */
  prepareFromFolder(path: unknown): Promise<ExtensionResult> {
    if (!this.allowed())
      return Promise.resolve({ ok: false, error: 'Turn extensions on in General settings first.' });
    if (typeof path !== 'string' || !GLib.file_test(path, GLib.FileTest.IS_DIR)) {
      return Promise.resolve({ ok: false, error: 'That is not a folder.' });
    }
    return this.prepare(async (work) => {
      const files = GLib.build_filenamev([work, 'files']);
      await Gio.Subprocess.new(
        ['cp', '-r', path, files],
        Gio.SubprocessFlags.STDERR_SILENCE,
      ).wait_check_async(null);
      // A folder has no id of its own: it gets one from its path.
      const sum = GLib.Checksum.new(GLib.ChecksumType.SHA256);
      sum.update(new TextEncoder().encode(GLib.canonicalize_filename(path, null)));
      return extensionIdFrom(this.hexBytes(sum.get_string()));
    }, 'folder');
  }

  /** The user accepted what the extension asks for: keep it and turn it on. */
  async confirm(): Promise<ExtensionResult> {
    const pending = this.pending;
    if (!pending) return { ok: false, error: 'Nothing is waiting to be installed.' };
    const { id } = pending.summary;
    const target = GLib.build_filenamev([this.root, id]);
    const oldStorage = GLib.build_filenamev([target, 'storage.json']);
    let storage: Uint8Array | null = null;
    try {
      [, storage] = GLib.file_get_contents(oldStorage);
    } catch {
      // A first install: nothing of the old one to keep.
    }
    const existed = this.installed.has(id);
    removeTree(target);
    ensureDir(target);
    Gio.File.new_for_path(GLib.build_filenamev([pending.work, 'files'])).move(
      Gio.File.new_for_path(GLib.build_filenamev([target, 'files'])),
      Gio.FileCopyFlags.NONE,
      null,
      null,
    );
    removeTree(pending.work);
    if (storage) GLib.file_set_contents(oldStorage, storage);
    this.fresh.set(id, existed ? 'update' : 'install');
    const meta: ExtensionMeta = {
      version: 1,
      id,
      enabled: true,
      source: pending.source,
      installedAt: Date.now(),
    };
    await writeText(GLib.build_filenamev([target, 'meta.json']), `${JSON.stringify(meta)}\n`);
    this.pending = null;
    this.installed.delete(id);
    this.loadOne(id);
    this.emit();
    return { ok: true, id };
  }

  /** The user turned the extension down: nothing is kept. */
  cancel(): ExtensionResult {
    if (this.pending) removeTree(this.pending.work);
    this.pending = null;
    this.emit();
    return { ok: true, id: '' };
  }

  async setEnabled(id: unknown, enabled: unknown): Promise<ExtensionResult> {
    const extension = typeof id === 'string' ? this.installed.get(id) : undefined;
    if (!extension || typeof enabled !== 'boolean')
      return { ok: false, error: 'No such extension.' };
    extension.meta = { ...extension.meta, enabled };
    await writeText(
      GLib.build_filenamev([this.root, extension.summary.id, 'meta.json']),
      `${JSON.stringify(extension.meta)}\n`,
    );
    this.emit();
    return { ok: true, id: extension.summary.id };
  }

  remove(id: unknown): ExtensionResult {
    if (typeof id !== 'string' || !this.installed.has(id))
      return { ok: false, error: 'No such extension.' };
    removeTree(GLib.build_filenamev([this.root, id]));
    removeTree(GLib.build_filenamev([cacheDir(), 'extensions', id]));
    this.installed.delete(id);
    this.actions.delete(id);
    this.fresh.delete(id);
    this.emit();
    return { ok: true, id };
  }

  private async prepare(
    fill: (work: string) => Promise<string>,
    source: 'store' | 'folder',
  ): Promise<ExtensionResult> {
    if (this.busy !== null) return { ok: false, error: 'Busy with another extension.' };
    this.cancel();
    const work = GLib.build_filenamev([
      cacheDir(),
      'extensions',
      `.work-${String(GLib.get_monotonic_time())}`,
    ]);
    ensureDir(work);
    this.busy =
      source === 'store' ? 'Downloading from the Chrome Web Store…' : 'Reading the folder…';
    this.emit();
    try {
      const id = await fill(work);
      const summary = this.readSummary(GLib.build_filenamev([work, 'files']), id);
      this.pending = { summary, work, source };
      return { ok: true, id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug('extensions', `preparing failed: ${message}`);
      removeTree(work);
      return { ok: false, error: message };
    } finally {
      this.busy = null;
      this.emit();
    }
  }

  /** Asks the Web Store for the package, checks it is the extension asked for, and unpacks it. */
  private async downloadStorePackage(id: string, work: string): Promise<string> {
    const query = `id=${id}&installsource=ondemand&uc`;
    const url = `${STORE}?response=redirect&os=linux&arch=x64&os_arch=x86_64&nacl_arch=x86-64&prod=chromiumcrx&prodchannel=&prodversion=${PRODUCT_VERSION}&lang=en-US&acceptformat=crx3&x=${encodeURIComponent(query)}`;
    const crxPath = GLib.build_filenamev([work, 'package.crx']);
    try {
      await this.http.download(url, crxPath, MAX_CRX_BYTES, () => undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        /answered (204|400|404)/.test(message)
          ? 'The Chrome Web Store has no package for that extension (it may not exist, or not be offered for download).'
          : message,
        { cause: error },
      );
    }
    const [, bytes] = GLib.file_get_contents(crxPath);
    const parsed = parseCrx(bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    const { header } = parsed;
    // The package has to be the one asked for: its id comes from the developer's key, which signed it.
    const claimed = header.crxId ? extensionIdFrom(header.crxId) : null;
    const fromKey = header.publicKeys.map((key) => {
      const sum = GLib.Checksum.new(GLib.ChecksumType.SHA256);
      sum.update(key);
      return extensionIdFrom(this.hexBytes(sum.get_string()));
    });
    const trusted = header.crxId ? fromKey.includes(claimed ?? '') : fromKey.includes(id);
    if ((claimed !== null && claimed !== id) || !trusted || !fromKey.includes(id)) {
      throw new Error('The package is not signed for the extension that was asked for.');
    }
    const zip = GLib.build_filenamev([work, 'package.zip']);
    GLib.file_set_contents(zip, bytes.subarray(header.zipOffset));
    const files = GLib.build_filenamev([work, 'files']);
    ensureDir(files);
    await Gio.Subprocess.new(
      ['unzip', '-q', '-o', zip, '-d', files],
      Gio.SubprocessFlags.STDERR_SILENCE,
    ).wait_check_async(null);
    return id;
  }

  private hexBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }

  private readSummary(files: string, id: string): ExtensionSummary {
    const manifestPath = GLib.build_filenamev([files, 'manifest.json']);
    const [, bytes] = GLib.file_get_contents(manifestPath);
    if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('manifest.json is too big.');
    const checked = validateManifest(parseJsonc(new TextDecoder().decode(bytes)));
    if (!checked.ok) throw new Error(checked.error);
    const manifest = checked.manifest;
    const messages = this.messagesOf(files, manifest);
    const name = translate(manifest.name, messages);
    const description = translate(manifest.description ?? '', messages);
    return summarize({ ...manifest, name }, id, description, this.iconOf(files, manifest));
  }

  private messagesOf(
    files: string,
    manifest: ExtensionManifest,
  ): Record<string, { message?: string }> {
    const locale = manifest.default_locale;
    if (!locale || !/^[A-Za-z_-]{2,12}$/.test(locale)) return {};
    const read = (name: string): Record<string, { message?: string }> | null => {
      try {
        const [, bytes] = GLib.file_get_contents(
          GLib.build_filenamev([files, '_locales', name, 'messages.json']),
        );
        return parseJsonc(new TextDecoder().decode(bytes)) as Record<string, { message?: string }>;
      } catch {
        return null;
      }
    };
    const base = read(locale) ?? {};
    // The user's own language (pt_BR, then pt) wins where the extension has it; the default fills the rest.
    for (const name of GLib.get_language_names()) {
      const clean = name.split('.')[0]?.split('@')[0] ?? '';
      if (clean === '' || clean === 'C' || !/^[A-Za-z_-]{2,12}$/.test(clean)) continue;
      const found = read(clean);
      if (found) return { ...base, ...found };
    }
    return base;
  }

  private iconOf(files: string, manifest: ExtensionManifest): string | null {
    const icons = Object.entries(manifest.icons ?? {}).sort((a, b) => Number(b[0]) - Number(a[0]));
    for (const [, relative] of icons) {
      if (typeof relative !== 'string' || relative.includes('..')) continue;
      try {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([files, relative]));
        if (bytes.length > MAX_ICON_BYTES) continue;
        const type = relative.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png';
        return `data:${type};base64,${GLib.base64_encode(bytes)}`;
      } catch {
        continue;
      }
    }
    return null;
  }

  private load(): void {
    try {
      const dir = GLib.Dir.open(this.root, 0);
      for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
        if (/^[a-p]{32}$/.test(name)) this.loadOne(name);
      }
    } catch {
      // No extensions folder yet.
    }
  }

  private loadOne(id: string): void {
    try {
      const folder = GLib.build_filenamev([this.root, id]);
      const files = GLib.build_filenamev([folder, 'files']);
      const [, metaBytes] = GLib.file_get_contents(GLib.build_filenamev([folder, 'meta.json']));
      const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as ExtensionMeta;
      const [, manifestBytes] = GLib.file_get_contents(
        GLib.build_filenamev([files, 'manifest.json']),
      );
      const checked = validateManifest(parseJsonc(new TextDecoder().decode(manifestBytes)));
      if (!checked.ok || meta.id !== id) return;
      const messages = this.messagesOf(files, checked.manifest);
      const manifest = { ...checked.manifest, name: translate(checked.manifest.name, messages) };
      try {
        const [, grantedBytes] = GLib.file_get_contents(
          GLib.build_filenamev([folder, 'granted.json']),
        );
        const granted = JSON.parse(new TextDecoder().decode(grantedBytes)) as {
          permissions?: string[];
          origins?: string[];
        };
        this.applyGrant(manifest, granted.permissions ?? [], granted.origins ?? []);
      } catch {
        // Nothing was granted at run time.
      }
      this.installed.set(id, {
        summary: summarize(
          manifest,
          id,
          translate(checked.manifest.description ?? '', messages),
          this.iconOf(files, manifest),
        ),
        manifest,
        meta,
        files,
        messages,
      });
    } catch (error) {
      debug('extensions', `could not load ${id}: ${String(error)}`);
    }
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
