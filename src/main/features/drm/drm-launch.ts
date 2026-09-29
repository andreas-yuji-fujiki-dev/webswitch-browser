import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import type { ChromePreferences } from '~types/drm';
import { ensureDir } from '../../core/files';
import { dataDir } from '../../core/paths';

/** Chrome's own profile for DRM pages: apart from the user's normal Chrome, and from Webswitch's data. */
export function drmProfileDir(): string {
  return GLib.build_filenamev([dataDir(), 'drm-profile']);
}

/**
 * The command line for a DRM page. WebAuthn is switched off so Google's sign-in falls back to a
 * password instead of offering passkeys. `embedded` is for a window that will live inside a tab: X11,
 * and a tiny window in the corner, because it can be seen for a moment before it is moved into the tab.
 */
export function chromeArguments(executable: string, url: string, embedded: boolean): string[] {
  return [
    executable,
    `--app=${url}`,
    `--user-data-dir=${drmProfileDir()}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=WebAuth',
    // Without this Chrome shows a bar, inside the window, warning about the unsupported flag above.
    '--test-type',
    ...(embedded
      ? ['--ozone-platform=x11', '--window-size=64,64', '--window-position=30000,30000']
      : []),
  ];
}

// Chrome's content setting values: 2 = block.
const BLOCK = 2;

/**
 * Notifications are blocked for every site, so Chrome never asks "Allow notifications?". Site
 * permissions are meant to be managed in Webswitch, not in this Chrome. Chrome rewrites its
 * preferences while it runs, so this only edits them while it is not running.
 */
export function prepareProfile(): void {
  const profile = drmProfileDir();
  const running = GLib.file_test(
    GLib.build_filenamev([profile, 'SingletonLock']),
    GLib.FileTest.IS_SYMLINK,
  );
  if (running) return;
  const dir = GLib.build_filenamev([profile, 'Default']);
  ensureDir(dir);
  const path = GLib.build_filenamev([dir, 'Preferences']);
  let prefs: ChromePreferences = {};
  try {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (ok) prefs = JSON.parse(new TextDecoder().decode(bytes)) as ChromePreferences;
  } catch {
    // No preferences yet (first run), or unreadable: start from an empty set.
  }
  prefs.profile ??= {};
  prefs.profile.default_content_setting_values ??= {};
  prefs.profile.default_content_setting_values.notifications = BLOCK;
  GLib.file_set_contents(path, JSON.stringify(prefs));
}

/** The process id in Chrome's profile lock ("host-1234" is a symlink target), or null. */
export function drmBrowserPid(): number | null {
  const lock = Gio.File.new_for_path(GLib.build_filenamev([drmProfileDir(), 'SingletonLock']));
  try {
    const target = lock
      .query_info('standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
      .get_symlink_target();
    const pid = Number(target?.split('-').at(-1));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
