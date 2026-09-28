import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';
import { DEFAULT_DEVTOOLS_PROVIDER, DEVTOOLS_PROVIDERS } from '~shared/devtools-catalog';
import { compareVersions, isReleaseVersion } from '~shared/version';
import { debug } from '../../core/debug';
import { ensureDir, removeTree, treeSize, writeText } from '../../core/files';
import { configDir, dataDir, distDir } from '../../core/paths';
import type { Unsubscribe } from '~types/common';
import type {
  DevToolsFile,
  RegistryAnswer,
  RegistryListing,
  DevToolsProviderId,
  DevToolsProviderStatus,
  DevToolsResult,
  DevToolsState,
} from '~types/devtools';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async', 'wait_check_finish');

// The only address a download may come from: the npm registry's metadata, then the tarball it names.
const REGISTRY = 'https://registry.npmjs.org/';
const PACKAGE_URL = `${REGISTRY}chii`;
// Every release the registry has (a few dozen), so any older one can be installed.
const MAX_VERSIONS_LISTED = 500;
const VERSION_FILE = 'version.json';
// The registry's short listing (a full one is several times larger).
const SHORT_LISTING = 'application/vnd.npm.install-v1+json';
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const FILE_NAME = 'devtools.json';

function isProviderId(value: unknown): value is DevToolsProviderId {
  return DEVTOOLS_PROVIDERS.some((provider) => provider.id === value);
}

/**
 * Which developer tools F12 opens, and the Chrome DevTools files on disk. A copy comes with the app
 * (`dist/devtools/chrome`, the "seed"); a release the user installed lives under
 * `~/.local/share/webswitch/devtools/chrome` and wins over the seed. Uninstalling deletes that copy
 * and sets the seed aside (`seedRemoved`): the app folder is not the user's to empty. The choice is
 * remembered in `~/.config/webswitch/devtools.json`.
 */
export class DevToolsService {
  private readonly filePath = GLib.build_filenamev([configDir(), FILE_NAME]);
  private active: DevToolsProviderId = DEFAULT_DEVTOOLS_PROVIDER;
  private seedRemoved = false;
  private readonly busy = new Map<DevToolsProviderId, 'downloading' | 'removing'>();
  private readonly percent = new Map<DevToolsProviderId, number>();
  private readonly errors = new Map<DevToolsProviderId, string>();
  private readonly sizes = new Map<DevToolsProviderId, number>();
  private readonly listeners = new Set<(state: DevToolsState) => void>();
  private readonly session = new Soup.Session({ timeout: 30 });
  private registry: DevToolsState['registry'] = {
    checking: false,
    versions: [],
    latest: null,
    error: null,
  };

  constructor() {
    try {
      const [, bytes] = GLib.file_get_contents(this.filePath);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<DevToolsFile>;
      if (isProviderId(parsed.active)) this.active = parsed.active;
      this.seedRemoved = parsed.seedRemoved === true;
    } catch {
      // No file yet: the default applies.
    }
    this.adoptOldDownload();
  }

  /** The tools F12 opens; falls back to Chrome DevTools, then to WebKit's, when the chosen one is not on disk. */
  activeProvider(): DevToolsProviderId {
    if (this.isInstalled(this.active)) return this.active;
    return this.isInstalled(DEFAULT_DEVTOOLS_PROVIDER) ? DEFAULT_DEVTOOLS_PROVIDER : 'webkit';
  }

  /** The folder with `front_end/` and `target.js` for a Chrome-style provider, or null. */
  frontendDir(id: string): string | null {
    return isProviderId(id) ? (this.locate(id)?.dir ?? null) : null;
  }

  getState(): DevToolsState {
    return {
      active: this.activeProvider(),
      providers: DEVTOOLS_PROVIDERS.map((provider): DevToolsProviderStatus => {
        const installed = this.isInstalled(provider.id);
        const version = installed ? this.versionOf(provider.id) : null;
        return {
          id: provider.id,
          installed,
          location: this.locate(provider.id)?.location ?? null,
          version,
          updateAvailable:
            provider.source === 'download' &&
            version !== null &&
            this.registry.latest !== null &&
            compareVersions(this.registry.latest, version) > 0,
          sizeBytes: provider.source === 'builtin' || !installed ? null : this.sizeOf(provider.id),
          busy: this.busy.get(provider.id) ?? null,
          percent: this.percent.get(provider.id) ?? null,
          error: this.errors.get(provider.id) ?? null,
        };
      }),
      registry: this.registry,
    };
  }

  onChanged(listener: (state: DevToolsState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  use(id: unknown): DevToolsResult {
    if (!isProviderId(id)) return { ok: false, error: 'Unknown developer tools.' };
    if (!this.isInstalled(id)) return { ok: false, error: 'Install it first.' };
    this.active = id;
    this.save();
    this.emit();
    return { ok: true };
  }

  /** Asks the registry which releases exist. Only ever runs because the user pressed Check. */
  async check(): Promise<DevToolsResult> {
    if (this.registry.checking) return { ok: false, error: 'Already checking.' };
    this.registry = { ...this.registry, checking: true, error: null };
    this.emit();
    try {
      const listing = JSON.parse(
        new TextDecoder().decode(await this.get(PACKAGE_URL, 8_000_000, undefined, SHORT_LISTING)),
      ) as RegistryListing;
      const versions = Object.keys(listing.versions ?? {})
        .filter(isReleaseVersion)
        .sort((a, b) => compareVersions(b, a))
        .slice(0, MAX_VERSIONS_LISTED);
      const latest = listing['dist-tags']?.latest;
      this.registry = {
        checking: false,
        versions,
        latest: isReleaseVersion(latest) ? latest : (versions[0] ?? null),
        error: null,
      };
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug('devtools', `check failed: ${message}`);
      this.registry = { ...this.registry, checking: false, error: message };
      return { ok: false, error: message };
    } finally {
      this.emit();
    }
  }

  async download(id: unknown, version?: unknown): Promise<DevToolsResult> {
    if (!isProviderId(id)) return { ok: false, error: 'Unknown developer tools.' };
    const definition = DEVTOOLS_PROVIDERS.find((provider) => provider.id === id);
    if (definition?.source !== 'download') return { ok: false, error: 'Nothing to download.' };
    if (this.busy.has(id)) return { ok: false, error: 'Already busy.' };
    // No release named (the page asks for the newest) arrives as null: JSON has no undefined.
    const release = version ?? undefined;
    if (release !== undefined && !isReleaseVersion(release)) {
      return { ok: false, error: 'That is not a release number.' };
    }
    // Putting back the release that comes with the app needs no download.
    if (release !== undefined && release === this.seedVersion()) {
      removeTree(this.dataDirectory(id));
      this.seedRemoved = false;
      this.sizes.delete(id);
      this.errors.delete(id);
      this.save();
      this.emit();
      return { ok: true };
    }
    this.busy.set(id, 'downloading');
    this.percent.set(id, 0);
    this.errors.delete(id);
    this.emit();
    try {
      await this.fetchAndInstall(id, release);
      this.seedRemoved = false;
      this.save();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug('devtools', `download failed: ${message}`);
      this.errors.set(id, message);
      return { ok: false, error: message };
    } finally {
      this.busy.delete(id);
      this.percent.delete(id);
      this.sizes.delete(id);
      this.emit();
    }
  }

  uninstall(id: unknown): DevToolsResult {
    if (!isProviderId(id)) return { ok: false, error: 'Unknown developer tools.' };
    const definition = DEVTOOLS_PROVIDERS.find((provider) => provider.id === id);
    if (definition?.source !== 'download') {
      return { ok: false, error: 'The built-in inspector cannot be removed.' };
    }
    if (this.busy.has(id)) return { ok: false, error: 'Busy.' };
    removeTree(this.dataDirectory(id));
    // The copy inside the app folder is not deleted; it is just no longer offered.
    this.seedRemoved = true;
    this.sizes.delete(id);
    this.errors.delete(id);
    this.save();
    this.emit();
    return { ok: true };
  }

  private dataDirectory(id: DevToolsProviderId): string {
    return GLib.build_filenamev([dataDir(), 'devtools', id]);
  }

  private seedDirectory(id: DevToolsProviderId): string {
    return GLib.build_filenamev([distDir(), 'devtools', id]);
  }

  /** Where the files in use are: a release the user installed, else the copy that comes with the app. */
  private locate(id: DevToolsProviderId): { dir: string; location: 'app' | 'downloaded' } | null {
    if (DEVTOOLS_PROVIDERS.find((provider) => provider.id === id)?.source !== 'download') {
      return null;
    }
    const has = (dir: string): boolean =>
      GLib.file_test(GLib.build_filenamev([dir, 'target.js']), GLib.FileTest.EXISTS);
    const downloaded = this.dataDirectory(id);
    if (has(downloaded)) return { dir: downloaded, location: 'downloaded' };
    const seed = this.seedDirectory(id);
    return !this.seedRemoved && has(seed) ? { dir: seed, location: 'app' } : null;
  }

  /** The release that comes with the app, whether or not it is set aside. */
  private seedVersion(): string | null {
    return this.readVersion(this.seedDirectory('chrome'));
  }

  private isInstalled(id: DevToolsProviderId): boolean {
    const source = DEVTOOLS_PROVIDERS.find((provider) => provider.id === id)?.source;
    return source === 'builtin' || this.locate(id) !== null;
  }

  private sizeOf(id: DevToolsProviderId): number | null {
    const known = this.sizes.get(id);
    if (known !== undefined) return known;
    const dir = this.locate(id)?.dir;
    if (dir === undefined) return null;
    const size = treeSize(dir);
    this.sizes.set(id, size);
    return size;
  }

  private save(): void {
    const file: DevToolsFile = {
      version: 1,
      active: this.active,
      ...(this.seedRemoved ? { seedRemoved: true } : {}),
    };
    void writeText(this.filePath, `${JSON.stringify(file)}\n`).catch((error: unknown) => {
      debug('devtools', `could not save ${this.filePath}: ${String(error)}`);
    });
  }

  /** An earlier build called the downloaded copy `chrome-downloaded`; it is the same thing now. */
  private adoptOldDownload(): void {
    const old = GLib.build_filenamev([dataDir(), 'devtools', 'chrome-downloaded']);
    const current = this.dataDirectory('chrome');
    if (
      GLib.file_test(old, GLib.FileTest.IS_DIR) &&
      !GLib.file_test(current, GLib.FileTest.EXISTS)
    ) {
      Gio.File.new_for_path(old).move(
        Gio.File.new_for_path(current),
        Gio.FileCopyFlags.NONE,
        null,
        null,
      );
    }
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  private setPercent(id: DevToolsProviderId, percent: number): void {
    this.percent.set(id, Math.round(percent));
    this.emit();
  }

  /** Metadata, then the tarball it names, checked against its checksum, then unpacked. */
  private async fetchAndInstall(id: DevToolsProviderId, wanted?: string): Promise<void> {
    const target = this.dataDirectory(id);

    const metaBytes = await this.get(`${PACKAGE_URL}/${wanted ?? 'latest'}`, 1_000_000);
    const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as RegistryAnswer;
    if (!isReleaseVersion(meta.version)) throw new Error('The registry did not name a release.');
    const tarball = meta.dist?.tarball;
    const integrity = meta.dist?.integrity;
    if (!tarball?.startsWith(REGISTRY) || !integrity?.startsWith('sha512-')) {
      throw new Error('The registry answered with something unexpected.');
    }
    this.setPercent(id, 5);

    const data = await this.get(tarball, MAX_DOWNLOAD_BYTES, (fraction) => {
      this.setPercent(id, 5 + fraction * 85);
    });
    const sum = GLib.Checksum.new(GLib.ChecksumType.SHA512);
    sum.update(data);
    const expected = Array.from(GLib.base64_decode(integrity.slice('sha512-'.length)))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    if (sum.get_string() !== expected) throw new Error('The download does not match its checksum.');
    this.setPercent(id, 92);

    const work = `${target}.part`;
    removeTree(work);
    ensureDir(work);
    const archive = GLib.build_filenamev([work, 'package.tgz']);
    GLib.file_set_contents(archive, data);
    const unpacked = GLib.build_filenamev([work, 'unpacked']);
    ensureDir(unpacked);
    const tar = Gio.Subprocess.new(
      [
        'tar',
        '-xzf',
        archive,
        '-C',
        unpacked,
        '--strip-components=2',
        'package/public/front_end',
        'package/public/target.js',
      ],
      Gio.SubprocessFlags.STDERR_SILENCE,
    );
    await tar.wait_check_async(null);
    if (!GLib.file_test(GLib.build_filenamev([unpacked, 'target.js']), GLib.FileTest.EXISTS)) {
      throw new Error('The package does not contain the developer tools.');
    }
    GLib.file_set_contents(
      GLib.build_filenamev([unpacked, VERSION_FILE]),
      JSON.stringify({ version: meta.version }),
    );
    removeTree(target);
    ensureDir(GLib.path_get_dirname(target));
    Gio.File.new_for_path(unpacked).move(
      Gio.File.new_for_path(target),
      Gio.FileCopyFlags.NONE,
      null,
      null,
    );
    removeTree(work);
  }

  /** The release the files in use are, or null when the folder does not say. */
  private versionOf(id: DevToolsProviderId): string | null {
    const dir = this.locate(id)?.dir;
    return dir === undefined ? null : this.readVersion(dir);
  }

  private readVersion(dir: string): string | null {
    try {
      const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([dir, VERSION_FILE]));
      const { version } = JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown };
      return isReleaseVersion(version) ? version : null;
    } catch {
      return null;
    }
  }

  private async get(
    url: string,
    limit: number,
    onProgress?: (fraction: number) => void,
    accept?: string,
  ): Promise<Uint8Array> {
    const message = Soup.Message.new('GET', url);
    if (message === null) throw new Error('Bad address.');
    if (accept) message.get_request_headers().append('Accept', accept);
    let total = 0;
    let received = 0;
    message.connect('got-headers', () => {
      total = message.get_response_headers().get_content_length();
      if (total > limit) this.session.abort();
    });
    message.connect('got-body-data', (_message, size) => {
      received += size;
      if (received > limit) this.session.abort();
      if (total > 0) onProgress?.(Math.min(1, received / total));
    });
    const bytes = await this.session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    if (message.get_status() !== Soup.Status.OK) {
      throw new Error(`The registry answered ${message.get_status()}.`);
    }
    return bytes.toArray();
  }
}
