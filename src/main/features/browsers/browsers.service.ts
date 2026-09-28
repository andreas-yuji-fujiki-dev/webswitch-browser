import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import { BROWSERS } from '~shared/browsers-catalog';
import { compareVersions } from '~shared/version';
import { debug } from '../../core/debug';
import { ensureDir, removeTree, treeSize, writeText } from '../../core/files';
import { Http } from '../../core/http';
import { cacheDir, configDir, dataDir } from '../../core/paths';
import { EXECUTABLES, listVersions, planInstall, RELEASE } from './browser-sources';
import type { Unsubscribe } from '~types/common';
import type {
  BrowserId,
  BrowserPhase,
  BrowserResult,
  BrowsersFile,
  BrowsersState,
  BrowserStatus,
  EmbedSpec,
  InstalledBrowser,
  InstallableBrowser,
  VersionListing,
} from '~types/browsers';

Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async', 'wait_check_finish');

const FILE_NAME = 'browsers.json';
const META_FILE = 'webswitch-install.json';
const MAX_DOWNLOAD_BYTES = 1_500_000_000;
const MIN_FREE_BYTES = 2_500_000_000;
// Browsers that play Netflix and Spotify (Widevine checked by hand: Chrome for Testing and Edge
// carry it; Opera's package does not, Firefox has it only with DRM switched on and shows its toolbar).
const STREAMING_CAPABLE: readonly InstallableBrowser[] = ['chrome', 'edge'];
const CHROMIUM: readonly InstallableBrowser[] = ['chrome', 'opera', 'edge'];

/** True when some browser was installed to test pages in (checked before the window exists). */
export function anyBrowserInstalled(): boolean {
  const root = GLib.build_filenamev([dataDir(), 'browsers']);
  try {
    const dir = GLib.Dir.open(root, 0);
    for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
      if (GLib.file_test(GLib.build_filenamev([root, name]), GLib.FileTest.IS_DIR)) return true;
    }
  } catch {
    // No folder yet.
  }
  return false;
}

function isInstallableBrowser(id: unknown): id is InstallableBrowser {
  return BROWSERS.some((browser) => browser.id === id && browser.source === 'download');
}

/** "154.0.8037.57" is "154": how the tab calls a release. */
function shortVersion(version: string): string {
  return version.replace(/esr$/, '').split('.')[0] ?? version;
}

/**
 * The browsers installed to test pages in (Chrome for Testing, Firefox, Opera, Edge), each release
 * in its own folder under `~/.local/share/webswitch/browsers/<browser>/<release>`. Nothing is
 * fetched until the user presses a button; every download is checked against the checksum the
 * vendor publishes when there is one. `browsers.json` remembers which release is in use.
 */
export class BrowsersService {
  private readonly root = GLib.build_filenamev([dataDir(), 'browsers']);
  private readonly filePath = GLib.build_filenamev([configDir(), FILE_NAME]);
  private readonly http = new Http();
  private active: Partial<Record<string, string>> = {};
  private streaming = 'system';
  private focus: { id: BrowserId; n: number; at: number } | null = null;
  private readonly listings = new Map<InstallableBrowser, VersionListing>();
  private readonly busy = new Map<
    InstallableBrowser,
    { phase: BrowserPhase; version: string | null; percent: number | null }
  >();
  private readonly errors = new Map<InstallableBrowser, string>();
  private readonly verified = new Map<InstallableBrowser, boolean>();
  private readonly sizes = new Map<string, number>();
  private readonly listeners = new Set<(state: BrowsersState) => void>();

  constructor(
    private readonly systemStreamingBrowser: () => string | null,
    /** Whether a tab can show another program's window now, and whether the setting asks for it. */
    private readonly embedding: () => { available: boolean; wanted: boolean },
  ) {
    try {
      const [, bytes] = GLib.file_get_contents(this.filePath);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<BrowsersFile>;
      this.active = parsed.active ?? {};
      if (typeof parsed.streaming === 'string') this.streaming = parsed.streaming;
    } catch {
      // Nothing chosen yet.
    }
  }

  onChanged(listener: (state: BrowsersState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): BrowsersState {
    const browsers = BROWSERS.map((browser): BrowserStatus => {
      if (!isInstallableBrowser(browser.id)) {
        return {
          id: browser.id,
          installed: [],
          versions: [],
          latest: null,
          updateAvailable: false,
          busy: null,
          error: null,
          verified: null,
        };
      }
      const id = browser.id;
      const installed = this.installedVersions(id);
      const latest = this.listings.get(id)?.latest ?? null;
      const newest = installed[0]?.version ?? null;
      return {
        id,
        installed,
        versions: this.listings.get(id)?.versions ?? [],
        latest,
        updateAvailable:
          latest !== null &&
          newest !== null &&
          compareVersions(latest.replace(/esr$/, ''), newest.replace(/esr$/, '')) > 0,
        busy: this.busy.get(id) ?? null,
        error: this.errors.get(id) ?? null,
        verified: this.verified.get(id) ?? null,
      };
    });
    return {
      browsers,
      totalBytes: browsers.reduce(
        (sum, browser) => sum + browser.installed.reduce((s, item) => s + item.sizeBytes, 0),
        0,
      ),
      streaming: this.streamingChoice(),
      systemStreamingBrowser: this.systemStreamingBrowser(),
      embedding: this.embeddingState(),
      focus: this.focus,
    };
  }

  /** Asks each vendor which releases exist. Only ever runs because the user pressed Check. */
  async check(): Promise<BrowserResult> {
    let failed: string | null = null;
    for (const browser of BROWSERS) {
      if (!isInstallableBrowser(browser.id) || this.busy.has(browser.id)) continue;
      const id = browser.id;
      this.setBusy(id, 'listing', null, null);
      this.errors.delete(id);
      try {
        this.listings.set(id, await listVersions(id, this.http));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debug('browsers', `listing ${id} failed: ${message}`);
        this.errors.set(id, `Could not list the releases: ${message}`);
        failed = message;
      } finally {
        this.busy.delete(id);
        this.emit();
      }
    }
    return failed === null ? { ok: true } : { ok: false, error: failed };
  }

  /** Downloads and unpacks a release (the newest when none is named). */
  async install(id: unknown, version?: unknown): Promise<BrowserResult> {
    if (!isInstallableBrowser(id)) return { ok: false, error: 'Unknown browser.' };
    const wanted = version ?? undefined;
    if (wanted !== undefined && !(typeof wanted === 'string' && RELEASE.test(wanted))) {
      return { ok: false, error: 'That is not a release number.' };
    }
    if (this.busy.has(id)) return { ok: false, error: 'Already busy.' };
    if (this.freeBytes() < MIN_FREE_BYTES) {
      return { ok: false, error: 'There is not enough free disk space (about 2.5 GB are needed).' };
    }
    this.errors.delete(id);
    this.setBusy(id, 'listing', wanted ?? null, null);
    let work: string | null = null;
    try {
      const plan = await planInstall(id, wanted, this.http);
      const target = this.folderOf(id, plan.version);
      if (GLib.file_test(target, GLib.FileTest.IS_DIR)) {
        this.active[id] = plan.version;
        this.save();
        return { ok: true };
      }
      work = `${target}.part`;
      removeTree(work);
      ensureDir(work);
      const archive = GLib.build_filenamev([work, 'download']);
      this.setBusy(id, 'downloading', plan.version, 0);
      const sha256 = await this.http.download(plan.url, archive, MAX_DOWNLOAD_BYTES, (fraction) => {
        this.setBusy(id, 'downloading', plan.version, Math.round(fraction * 100));
      });
      this.setBusy(id, 'verifying', plan.version, null);
      if (plan.sha256 !== null && plan.sha256 !== sha256) {
        throw new Error('The download does not match the checksum the vendor published.');
      }
      this.verified.set(id, plan.sha256 !== null);
      this.setBusy(id, 'unpacking', plan.version, null);
      const unpacked = GLib.build_filenamev([work, 'files']);
      ensureDir(unpacked);
      await this.unpack(plan.kind, archive, unpacked, work);
      if (this.executableIn(id, unpacked) === null) {
        throw new Error('The package does not contain the browser.');
      }
      GLib.file_set_contents(
        GLib.build_filenamev([unpacked, META_FILE]),
        JSON.stringify({ version: plan.version, verified: plan.sha256 !== null }),
      );
      ensureDir(GLib.path_get_dirname(target));
      Gio.File.new_for_path(unpacked).move(
        Gio.File.new_for_path(target),
        Gio.FileCopyFlags.NONE,
        null,
        null,
      );
      removeTree(work);
      work = null;
      this.sizes.delete(`${id}/${plan.version}`);
      this.active[id] = plan.version;
      this.save();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug('browsers', `install of ${id} failed: ${message}`);
      this.errors.set(id, message);
      if (work !== null) removeTree(work);
      return { ok: false, error: message };
    } finally {
      this.busy.delete(id);
      this.emit();
    }
  }

  /** Deletes one release to free the space. */
  uninstall(id: unknown, version: unknown): BrowserResult {
    if (!isInstallableBrowser(id) || typeof version !== 'string' || !RELEASE.test(version)) {
      return { ok: false, error: 'Unknown release.' };
    }
    if (this.busy.has(id)) return { ok: false, error: 'Busy.' };
    removeTree(this.folderOf(id, version));
    this.sizes.delete(`${id}/${version}`);
    if (this.active[id] === version) {
      this.active = Object.fromEntries(Object.entries(this.active).filter(([key]) => key !== id));
    }
    this.save();
    this.emit();
    return { ok: true };
  }

  /** Asks the page to show this browser's card (the icon of a browser that is not installed was clicked). */
  requestFocus(id: BrowserId): void {
    this.focus = { id, n: (this.focus?.n ?? 0) + 1, at: Date.now() };
    this.emit();
  }

  /** Chooses the release "Open this page in ..." uses. */
  use(id: unknown, version: unknown): BrowserResult {
    if (!isInstallableBrowser(id) || typeof version !== 'string') {
      return { ok: false, error: 'Unknown release.' };
    }
    if (!this.installedVersions(id).some((item) => item.version === version)) {
      return { ok: false, error: 'Install it first.' };
    }
    this.active[id] = version;
    this.save();
    this.emit();
    return { ok: true };
  }

  /** Chooses the browser that plays streaming sites: `system` or one that was installed here. */
  setStreaming(choice: unknown): BrowserResult {
    const wanted = typeof choice === 'string' ? choice : '';
    const managed = STREAMING_CAPABLE.find((id) => id === wanted);
    if (wanted !== 'system' && (managed === undefined || this.executable(managed) === null)) {
      return { ok: false, error: 'Install it first.' };
    }
    this.streaming = wanted;
    this.save();
    this.emit();
    return { ok: true };
  }

  /** The browser for streaming pages: the one chosen if it is installed, else null (use the system's). */
  streamingExecutable(): { path: string; name: string } | null {
    const choice = this.streamingChoice();
    if (choice === 'system') return null;
    const path = isInstallableBrowser(choice) ? this.executable(choice) : null;
    const name = BROWSERS.find((browser) => browser.id === choice)?.name;
    return path !== null && name !== undefined
      ? { path, name: `${name} (installed by Webswitch)` }
      : null;
  }

  /** True when this browser is installed (some release of it). */
  isInstalled(id: BrowserId): boolean {
    return isInstallableBrowser(id) && this.executable(id) !== null;
  }

  /** How to start `id` inside a tab on `url`, with a profile of its own that is deleted afterwards. */
  embedSpec(id: BrowserId, url: string): EmbedSpec | null {
    if (!isInstallableBrowser(id)) return null;
    const exe = this.executable(id);
    const version = this.activeVersion(id);
    if (exe === null || version === null) return null;
    const profile = GLib.build_filenamev([
      cacheDir(),
      'browser-profiles',
      `${id}-${String(GLib.get_monotonic_time())}`,
    ]);
    ensureDir(profile);
    const name = BROWSERS.find((browser) => browser.id === id)?.name ?? id;
    const cleanup = (): void => {
      // The browser may still be writing its profile as it exits.
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
        removeTree(profile);
        return GLib.SOURCE_REMOVE;
      });
    };
    const label = `${name} ${shortVersion(version)}`;
    if (id === 'firefox') {
      GLib.file_set_contents(
        GLib.build_filenamev([profile, 'user.js']),
        [
          'user_pref("browser.shell.checkDefaultBrowser", false);',
          'user_pref("browser.aboutwelcome.enabled", false);',
          'user_pref("browser.startup.homepage_override.mstone", "ignore");',
          // The Terms of Use notice of a new profile, and the title bar Firefox draws itself: the window
          // lives inside a tab, so it has no frame of its own (a frame would show as a margin).
          'user_pref("termsofuse.bypassNotification", true);',
          'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
          'user_pref("browser.tabs.inTitlebar", 0);',
          'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
          'user_pref("datareporting.healthreport.uploadEnabled", false);',
          'user_pref("toolkit.telemetry.enabled", false);',
          'user_pref("app.update.auto", false);',
          // DRM is off in a fresh profile; a page under test may use it.
          'user_pref("media.eme.enabled", true);',
          'user_pref("media.gmp-widevinecdm.enabled", true);',
          '',
        ].join('\n'),
      );
      return {
        argv: [exe, '--no-remote', '--profile', profile, '--width', '64', '--height', '64', url],
        // GTK_CSD=0: no client-side frame (title bar, rounded corners, shadow) around the window.
        env: ['GDK_BACKEND=x11', 'GTK_CSD=0'],
        label,
        killOnClose: true,
        cleanup,
      };
    }
    // Chromium draws its own frame (title bar, rounded corners, a shadow that shows as a margin);
    // inside a tab the window has no frame at all, so it is told to use the system's, which is none.
    ensureDir(GLib.build_filenamev([profile, 'Default']));
    GLib.file_set_contents(
      GLib.build_filenamev([profile, 'Default', 'Preferences']),
      JSON.stringify({
        browser: { custom_chrome_frame: false },
        profile: { default_content_setting_values: { notifications: 2 } },
      }),
    );
    return {
      argv: [
        exe,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--ozone-platform=x11',
        '--window-size=64,64',
        '--window-position=30000,30000',
        url,
      ],
      env: ['GDK_BACKEND=x11'],
      label,
      killOnClose: true,
      cleanup,
    };
  }

  /** Whether the browser is a Chromium one (Chrome, Opera, Edge). */
  isChromium(id: BrowserId): boolean {
    return CHROMIUM.some((candidate) => candidate === id);
  }

  /** `ready`: tabs can show these browsers. `restart`: it takes X11 mode, on at the next start. `off`: the setting is off. */
  private embeddingState(): BrowsersState['embedding'] {
    const { available, wanted } = this.embedding();
    if (available) return 'ready';
    return wanted ? 'restart' : 'off';
  }

  private streamingChoice(): string {
    if (this.streaming === 'system') return 'system';
    const managed = STREAMING_CAPABLE.find((id) => id === this.streaming);
    return managed !== undefined && this.executable(managed) !== null ? managed : 'system';
  }

  private folderOf(id: InstallableBrowser, version: string): string {
    return GLib.build_filenamev([this.root, id, version]);
  }

  private installedVersions(id: InstallableBrowser): InstalledBrowser[] {
    const folder = GLib.build_filenamev([this.root, id]);
    const found: string[] = [];
    try {
      const dir = GLib.Dir.open(folder, 0);
      for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
        if (RELEASE.test(name) && this.executableIn(id, this.folderOf(id, name)) !== null) {
          found.push(name);
        }
      }
    } catch {
      return [];
    }
    found.sort((a, b) => compareVersions(b.replace(/esr$/, ''), a.replace(/esr$/, '')));
    const inUse = this.activeVersion(id, found);
    return found.map((version) => ({
      version,
      sizeBytes: this.sizeOf(id, version),
      active: version === inUse,
    }));
  }

  /** The release in use: the one chosen if it is still installed, else the newest. */
  private activeVersion(id: InstallableBrowser, known?: string[]): string | null {
    const versions = known ?? this.installedVersions(id).map((item) => item.version);
    const chosen = this.active[id];
    if (chosen !== undefined && versions.includes(chosen)) return chosen;
    return versions[0] ?? null;
  }

  private executable(id: InstallableBrowser): string | null {
    const version = this.activeVersion(id);
    return version === null ? null : this.executableIn(id, this.folderOf(id, version));
  }

  private executableIn(id: InstallableBrowser, folder: string): string | null {
    for (const relative of EXECUTABLES[id]) {
      const path = GLib.build_filenamev([folder, relative]);
      if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) return path;
    }
    return null;
  }

  private sizeOf(id: InstallableBrowser, version: string): number {
    const key = `${id}/${version}`;
    const known = this.sizes.get(key);
    if (known !== undefined) return known;
    const size = treeSize(this.folderOf(id, version));
    this.sizes.set(key, size);
    return size;
  }

  private freeBytes(): number {
    try {
      ensureDir(this.root);
      return Gio.File.new_for_path(this.root)
        .query_filesystem_info('filesystem::free', null)
        .get_attribute_uint64('filesystem::free');
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  private async unpack(
    kind: 'zip' | 'tar' | 'deb',
    archive: string,
    destination: string,
    work: string,
  ): Promise<void> {
    const run = async (argv: string[], cwd?: string): Promise<void> => {
      const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDERR_SILENCE });
      if (cwd) launcher.set_cwd(cwd);
      await launcher.spawnv(argv).wait_check_async(null);
    };
    if (kind === 'zip') {
      await run(['unzip', '-q', archive, '-d', destination]);
    } else if (kind === 'tar') {
      await run(['tar', '-xf', archive, '-C', destination]);
    } else {
      // A .deb is an `ar` archive holding the files as data.tar.<compression>.
      const parts = GLib.build_filenamev([work, 'deb']);
      ensureDir(parts);
      await run(['ar', 'x', archive], parts);
      const data = this.firstFile(parts, /^data\.tar\.[a-z0-9]+$/);
      if (data === null) throw new Error('The package has no files in it.');
      await run(['tar', '-xf', data, '-C', destination]);
    }
  }

  private firstFile(folder: string, pattern: RegExp): string | null {
    try {
      const dir = GLib.Dir.open(folder, 0);
      for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
        if (pattern.test(name)) return GLib.build_filenamev([folder, name]);
      }
    } catch {
      return null;
    }
    return null;
  }

  private setBusy(
    id: InstallableBrowser,
    phase: BrowserPhase,
    version: string | null,
    percent: number | null,
  ): void {
    const before = this.busy.get(id);
    if (before?.phase === phase && before.version === version && before.percent === percent) return;
    this.busy.set(id, { phase, version, percent });
    this.emit();
  }

  private save(): void {
    const file: BrowsersFile = { version: 1, active: this.active, streaming: this.streaming };
    void writeText(this.filePath, `${JSON.stringify(file)}\n`).catch((error: unknown) => {
      debug('browsers', `could not save ${this.filePath}: ${String(error)}`);
    });
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
