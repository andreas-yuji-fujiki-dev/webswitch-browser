import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import type WebKit from 'gi://WebKit?version=6.0';
import { APP_NAME, FALLBACK_CHROME_HEIGHT, WINDOW } from './config';
import { isDark } from './theme';

// Mirrors the palette in renderer/styles/tokens.css. Only the parts GTK draws itself (the window
// buttons, the popup's close button, the window shape) need colors here.
const PALETTE = {
  dark: { fg: '#d3d3d3', hover: '#272727', accent: '#e8adb9', background: '#000000' },
  light: { fg: '#1a1a1a', hover: '#d3d3d3', accent: '#e8adb9', background: '#eff3bc' },
} as const;

function styles(): string {
  const p = isDark() ? PALETTE.dark : PALETTE.light;
  return `
    window.ws-window, window.ws-window.csd { border-radius: 0; background: ${p.background}; }
    windowcontrols.ws-controls { margin: 0; }
    windowcontrols.ws-controls button, button.ws-popup-close {
      min-width: 36px; min-height: 36px; padding: 0; margin: 0;
      border: none; border-radius: 0; box-shadow: none; background: none; color: ${p.fg};
    }
    windowcontrols.ws-controls button:hover, button.ws-popup-close:hover {
      background: ${p.hover}; color: ${p.accent};
    }
    popover.ws-menu, popover.ws-menu > contents {
      background: transparent; border: none; box-shadow: none; padding: 0; margin: 0;
    }
  `;
}

let provider: Gtk.CssProvider | null = null;

/** Applies the window styles once and re-applies them when the system switches light/dark. */
function installStyles(): void {
  if (provider) return;
  const display = Gdk.Display.get_default();
  if (!display) return;
  const css = new Gtk.CssProvider();
  provider = css;
  const apply = (): void => {
    css.load_from_string(styles());
  };
  apply();
  // Deprecated with no replacement for application-wide CSS.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  Gtk.Settings.get_default()?.connect('notify::gtk-interface-color-scheme', apply);
}

/**
 * The browser window. There is no title bar: the UI web view fills the whole window (tab strip,
 * toolbar and page area) and the tab views sit on top of it, below the chrome, exactly where the
 * UI leaves room for them. Empty space in the tab strip drags the window; the system's own window
 * buttons are drawn over the strip's end.
 */
export class MainWindow {
  readonly window: Gtk.ApplicationWindow;
  readonly overlay = new Gtk.Overlay();
  /** The page area: one child per tab. */
  readonly stack = new Gtk.Stack({ hexpand: true, vexpand: true });
  private readonly dragHandle = new Gtk.WindowHandle();
  private readonly controls = Gtk.WindowControls.new(Gtk.PackType.END);
  private chromeHeight = FALLBACK_CHROME_HEIGHT;

  constructor(
    app: Gtk.Application,
    readonly ui: WebKit.WebView,
  ) {
    installStyles();
    this.window = new Gtk.ApplicationWindow({
      application: app,
      title: APP_NAME,
      default_width: WINDOW.width,
      default_height: WINDOW.height,
    });
    this.window.set_size_request(WINDOW.minWidth, WINDOW.minHeight);
    this.window.add_css_class('ws-window');
    // An invisible custom title bar: no bar, but the window keeps its resize edges and shape.
    const noTitleBar = new Gtk.Box();
    noTitleBar.set_visible(false);
    this.window.set_titlebar(noTitleBar);

    this.stack.set_margin_top(this.chromeHeight);
    this.stack.set_visible(false);
    this.dragHandle.set_halign(Gtk.Align.FILL);
    this.dragHandle.set_valign(Gtk.Align.START);
    this.controls.add_css_class('ws-controls');
    this.controls.set_halign(Gtk.Align.END);
    this.controls.set_valign(Gtk.Align.START);

    this.overlay.set_child(ui);
    this.overlay.add_overlay(this.stack);
    this.overlay.set_clip_overlay(this.stack, true);
    this.overlay.add_overlay(this.dragHandle);
    this.overlay.add_overlay(this.controls);
    this.window.set_child(this.overlay);
  }

  /** How much of the window's top the browser chrome takes; page views start below it. */
  setChromeHeight(heightPx: number): void {
    this.chromeHeight = Math.ceil(heightPx);
    this.stack.set_margin_top(this.chromeHeight);
  }

  /** Where the tab strip's empty, draggable space starts (CSS px) and how tall the strip is. */
  setTitleBarLayout(dragStartX: number, heightPx: number): void {
    this.dragHandle.set_margin_start(Math.max(0, Math.floor(dragStartX)));
    this.dragHandle.set_margin_end(this.controlsWidth());
    this.dragHandle.set_size_request(-1, Math.ceil(heightPx));
  }

  /** Width the system's window buttons take, so the UI can keep the tab strip clear of them. */
  controlsWidth(): number {
    const [, natural] = this.controls.measure(Gtk.Orientation.HORIZONTAL, -1);
    return natural;
  }

  /** HTML fullscreen (a video): the page covers the chrome and the window buttons get out of the way. */
  setContentFullscreen(fullscreen: boolean): void {
    this.stack.set_margin_top(fullscreen ? 0 : this.chromeHeight);
    this.controls.set_visible(!fullscreen);
    this.dragHandle.set_visible(!fullscreen);
    if (fullscreen) this.window.fullscreen();
    else this.window.unfullscreen();
  }
}
