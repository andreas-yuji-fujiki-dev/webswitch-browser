import Gdk from 'gi://Gdk?version=4.0';
import GdkX11 from 'gi://GdkX11?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import type Gtk from 'gi://Gtk?version=4.0';
import type { DrmBrowser, EmbedHandle } from '~types/drm';
import { distDir } from '../../core/paths';
import { chromeArguments, drmProfileDir, prepareProfile } from './drm-launch';
import { DRM_BROWSERS } from './drm-sites';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');

const decoder = new TextDecoder();
// The window is visible from the moment it exists until it has been moved into the tab, so both
// the lock file and the window are watched closely.
const ADOPT_POLL_MS = 20;
const ADOPT_WAIT_MS = 400;
const ADOPT_TIMEOUT_MS = 20_000;
const ALIVE_POLL_MS = 1000;

/**
 * Whether the browser should run on X11 so DRM pages can be embedded. On by default when it can
 * work (an X display, python3 for the helper, a Chromium-family browser); WEBSWITCH_EMBED_DRM=0
 * turns it off and keeps Wayland with the app-window hand-off.
 */
export function embeddingRequested(): boolean {
  if (GLib.getenv('WEBSWITCH_EMBED_DRM') === '0') return false;
  if (GLib.getenv('DISPLAY') === null || GLib.find_program_in_path('python3') === null)
    return false;
  return DRM_BROWSERS.some(({ command }) => GLib.find_program_in_path(command) !== null);
}

/** True when embedding was requested and the window really is an X11 one. */
export function embeddingAvailable(): boolean {
  return embeddingRequested() && Gdk.Display.get_default() instanceof GdkX11.X11Display;
}

/** The helper process that talks Xlib for us; one command per line, one answer per command. */
class X11Helper {
  private readonly process: Gio.Subprocess;
  private readonly input: Gio.DataOutputStream;
  private readonly output: Gio.DataInputStream;
  private chain: Promise<unknown> = Promise.resolve();

  constructor() {
    const script = GLib.build_filenamev([distDir(), 'x11-embed.py']);
    this.process = Gio.Subprocess.new(
      ['python3', script],
      Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
    );
    this.input = new Gio.DataOutputStream({
      base_stream: this.process.get_stdin_pipe() ?? undefined,
    });
    this.output = new Gio.DataInputStream({
      base_stream: this.process.get_stdout_pipe() ?? undefined,
    });
  }

  /** Commands run strictly one after the other, so answers always match their command. */
  request(line: string): Promise<string> {
    const answer = this.chain.then(async () => {
      this.input.put_string(`${line}\n`, null);
      this.input.flush(null);
      const [bytes] = await this.output.read_line_async(GLib.PRIORITY_DEFAULT, null);
      return bytes === null ? 'error helper closed' : decoder.decode(bytes);
    });
    this.chain = answer.catch(() => undefined);
    return answer;
  }

  dispose(): void {
    this.process.force_exit();
  }
}

/**
 * EXPERIMENTAL. Puts a real Chrome window inside a tab: the window is launched in app mode and
 * reparented (X11) into a container that follows the tab's area. Needs the whole browser to run on
 * X11 (through XWayland), because Wayland has no way to embed another program's window.
 */
export class EmbedService {
  constructor(
    private readonly window: Gtk.Window,
    private readonly browser: () => DrmBrowser | null,
    /** True while something (the ⋮ menu) must be drawn over the tab area. */
    private readonly covered: () => boolean,
  ) {}

  /** Embeds `url` in a Chrome window over `area`. Returns null when it cannot be started. */
  attach(area: Gtk.Widget, url: string): EmbedHandle | null {
    const browser = this.browser();
    const surface = this.window.get_surface();
    if (!browser || !(surface instanceof GdkX11.X11Surface)) return null;
    prepareProfile();

    const helper = new X11Helper();
    const closedListeners: (() => void)[] = [];
    const titleListeners: ((title: string) => void)[] = [];
    let lastTitle = '';
    let closed = false;
    let ready = false;
    let visible = false;
    let lastRect = '';
    let tick = 0;
    let alive = 0;

    const finish = (notify: boolean): void => {
      if (closed) return;
      closed = true;
      if (tick !== 0) area.remove_tick_callback(tick);
      if (alive !== 0) GLib.source_remove(alive);
      // Give the helper a moment to deliver the "close" message before it is stopped.
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
        helper.dispose();
        return GLib.SOURCE_REMOVE;
      });
      if (notify) for (const listener of closedListeners) listener();
    };

    const geometry = (): string | null => {
      const [ok, bounds] = area.compute_bounds(this.window);
      if (!ok) return null;
      const [dx, dy] = this.window.get_surface_transform();
      const scale = surface.get_scale_factor();
      const x = Math.round((bounds.get_x() + dx) * scale);
      const y = Math.round((bounds.get_y() + dy) * scale);
      const w = Math.max(1, Math.round(bounds.get_width() * scale));
      const h = Math.max(1, Math.round(bounds.get_height() * scale));
      return `${x} ${y} ${w} ${h}`;
    };

    // Follows the tab: position, size, and whether the tab is showing at all.
    const sync = (): void => {
      if (!ready || closed) return;
      const wantVisible = area.get_mapped() && !this.covered();
      const rect = geometry();
      if (rect !== null && rect !== lastRect) {
        lastRect = rect;
        void helper.request(`place ${rect}`);
      }
      if (wantVisible !== visible) {
        visible = wantVisible;
        void helper.request(wantVisible ? 'show' : 'hide');
        if (wantVisible) void helper.request('focus');
      }
    };

    void (async () => {
      // Deprecated in GTK 4.18 with no replacement in GJS typings; still the way to get the X11 window id.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const xid = surface.get_xid();
      const init = await helper.request(`init ${xid}`);
      if (!init.startsWith('ok')) {
        finish(true);
        return;
      }
      try {
        Gio.Subprocess.new(chromeArguments(browser.path, url, true), Gio.SubprocessFlags.NONE);
      } catch {
        finish(true);
        return;
      }

      // Chrome's process for this profile owns every window we launch; SingletonLock names it.
      const started = GLib.get_monotonic_time();
      const timedOut = (): boolean =>
        (GLib.get_monotonic_time() - started) / 1000 > ADOPT_TIMEOUT_MS;
      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) =>
          GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => (resolve(), GLib.SOURCE_REMOVE)),
        );
      for (;;) {
        if (closed) return;
        if (timedOut()) {
          finish(true);
          return;
        }
        const pid = this.browserPid();
        if (pid !== null) {
          const answer = await helper.request(`adopt pid ${pid} ${ADOPT_WAIT_MS}`);
          if (answer.startsWith('ok')) break;
        }
        await sleep(ADOPT_POLL_MS);
      }
      ready = true;
      lastRect = '';
      tick = area.add_tick_callback(() => {
        sync();
        return GLib.SOURCE_CONTINUE;
      });
      this.window.connect('notify::is-active', () => {
        if (this.window.is_active && visible) void helper.request('focus');
      });
      alive = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ALIVE_POLL_MS, () => {
        if (closed) return GLib.SOURCE_REMOVE;
        void helper.request('alive').then((answer) => {
          if (answer === 'ok 0') finish(true);
        });
        void helper.request('title').then((answer) => {
          const title = answer.startsWith('ok ') ? answer.slice(3) : '';
          if (title === '' || title === lastTitle || closed) return;
          lastTitle = title;
          for (const listener of titleListeners) listener(title);
        });
        return GLib.SOURCE_CONTINUE;
      });
      sync();
      // Debugging aid: WEBSWITCH_EMBED_SHOT=/path.png saves what the embedded window shows, once.
      const shot = GLib.getenv('WEBSWITCH_EMBED_SHOT');
      if (shot) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8000, () => {
          void helper.request(`shot ${shot}`).then((answer) => {
            console.log(`embed shot: ${answer}`);
          });
          return GLib.SOURCE_REMOVE;
        });
      }
    })();

    return {
      onClosed: (listener) => {
        closedListeners.push(listener);
      },
      onTitle: (listener) => {
        titleListeners.push(listener);
      },
      focus: () => {
        if (ready && !closed) void helper.request('focus');
      },
      close: () => {
        if (closed) return;
        void helper.request('close');
        finish(false);
      },
    };
  }

  /** The process id in Chrome's profile lock ("host-1234" is a symlink target), or null. */
  private browserPid(): number | null {
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
}
