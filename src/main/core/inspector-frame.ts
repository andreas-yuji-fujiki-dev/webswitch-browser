import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import type WebKit from 'gi://WebKit?version=6.0';
import type { EdgeRect } from '~types/devtools';
import { INSPECTOR_EDGE_PX } from './config';
import type { MainWindow } from './window';

const FIND_WINDOW_TRIES = 30;
const FIND_WINDOW_MS = 200;

/**
 * Dresses the Web Inspector in the theme's main color. Docked under, beside or before the page it
 * gets a line along the edge that faces the page (top when it is below the page, left when it is
 * on the right, right when it is on the left); in a window of its own it loses the title bar and
 * the rounded corners and gets the line on every side. WebKit draws the inspector's insides itself,
 * so those keep WebKit's own colors.
 */
export class InspectorFrame {
  private last: EdgeRect | null = null;

  constructor(private readonly main: MainWindow) {}

  /** Follows the inspector of `host`, a view that can have one (a tab, or the UI itself). */
  watch(host: WebKit.WebView): void {
    const inspector = host.get_inspector();
    let tick = 0;
    const stop = (): void => {
      if (tick !== 0) host.remove_tick_callback(tick);
      tick = 0;
      this.show(null);
    };
    inspector.connect('attach', () => {
      // Only while docked: the edge follows the inspector as the window or the dock changes.
      if (tick === 0) {
        tick = host.add_tick_callback(() => {
          this.follow(host, inspector);
          return GLib.SOURCE_CONTINUE;
        });
      }
      return false;
    });
    inspector.connect('detach', () => {
      stop();
      return false;
    });
    inspector.connect('closed', () => {
      stop();
    });
    // The page is not on screen (another tab, or the UI shows a page): so is its inspector.
    host.connect('unmap', () => {
      this.show(null);
    });
    inspector.connect('open-window', () => {
      this.dressWindow();
      return false;
    });
  }

  private follow(host: WebKit.WebView, inspector: WebKit.WebInspector): void {
    const view = inspector.get_web_view();
    if (!view || !host.get_mapped() || inspector.get_attached_height() === 0) {
      this.show(null);
      return;
    }
    const [inspectorKnown, inner] = view.compute_bounds(this.main.overlay);
    const [hostKnown, outer] = host.compute_bounds(this.main.overlay);
    if (!inspectorKnown || !hostKnown) return;
    const x = Math.round(inner.get_x());
    const y = Math.round(inner.get_y());
    const width = Math.round(inner.get_width());
    const height = Math.round(inner.get_height());
    const hostX = Math.round(outer.get_x());
    const hostWidth = Math.round(outer.get_width());
    const edge = INSPECTOR_EDGE_PX;
    if (width >= hostWidth - edge) {
      this.show({ x, y, width, height: edge }); // below the page: the line is on top
    } else if (x <= hostX + edge) {
      this.show({ x: x + width - edge, y, width: edge, height }); // on the left: the line is on the right
    } else {
      this.show({ x, y, width: edge, height }); // on the right: the line is on the left
    }
  }

  private show(rect: EdgeRect | null): void {
    const same =
      rect === this.last ||
      (rect !== null &&
        this.last !== null &&
        rect.x === this.last.x &&
        rect.y === this.last.y &&
        rect.width === this.last.width &&
        rect.height === this.last.height);
    if (same) return;
    this.last = rect;
    this.main.setInspectorEdge(rect);
  }

  /** The window WebKit opens for an inspector it does not dock: no title bar, square, framed. */
  private dressWindow(): void {
    let tries = 0;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, FIND_WINDOW_MS, () => {
      // Webswitch's own windows carry `ws-window`; the inspector's window is the one that does not.
      const found = Gtk.Window.list_toplevels().find(
        (candidate): candidate is Gtk.Window =>
          candidate instanceof Gtk.Window &&
          !candidate.has_css_class('ws-window') &&
          !candidate.has_css_class('ws-inspector-window'),
      );
      if (found) {
        found.set_decorated(false);
        found.add_css_class('ws-inspector-window');
        return GLib.SOURCE_REMOVE;
      }
      return ++tries < FIND_WINDOW_TRIES ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
    });
  }
}
