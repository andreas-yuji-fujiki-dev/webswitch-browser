import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import type WebKit from 'gi://WebKit?version=6.0';
import type { EdgeRect } from '~types/devtools';
import { APP_NAME, DEVTOOLS_PANEL, FALLBACK_CHROME_HEIGHT, MENU_PANEL, WINDOW } from './config';
import { debug } from './debug';
import { chromeColors } from './theme';

function styles(): string {
  // The active theme's colors: the parts GTK draws itself (window buttons, popup frame ...).
  const colors = chromeColors();
  const p = { fg: colors.fg, hover: colors.hover, accent: colors.accent, background: colors.bg };
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
    .ws-splitter { background: transparent; }
    .ws-inspector-edge { background: ${p.accent}; }
    .ws-devtools-splitter { background: transparent; border-top: 2px solid ${p.accent}; }
    .ws-devtools-splitter:hover, .ws-devtools-splitter.ws-dragging { background: ${p.accent}; }
    .ws-frame { border: 2px solid ${p.accent}; background: ${p.background}; }
    window.ws-inspector-window, window.ws-inspector-window.csd,
    window.ws-inspector-window decoration {
      border-radius: 0; border: 2px solid ${p.accent}; box-shadow: none; background: ${p.background};
    }
    .ws-splitter:hover, .ws-splitter.ws-dragging { background: ${p.accent}; }
  `;
}

let provider: Gtk.CssProvider | null = null;

/** Redraws with the colors of the theme now in use. */
export function refreshWindowStyles(): void {
  provider?.load_from_string(styles());
}

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
  private sidePanel: Gtk.Widget | null = null;
  private sidePanelOpen = false;
  private contentFullscreen = false;
  private sidePanelFraction: number = MENU_PANEL.defaultFraction;
  private readonly fractionListeners = new Set<(fraction: number, committed: boolean) => void>();
  /** The bar between the page and the panel; dragging it resizes the panel. */
  readonly splitter = new Gtk.Box();
  readonly splitterDrag = new Gtk.GestureDrag();
  private dragStartPanelX = 0;
  private dragStartPointerX: number | null = null;
  /** The Chrome DevTools panel under the page, when one is showing, and the bar that resizes it. */
  private devtoolsPanel: Gtk.Widget | null = null;
  private devtoolsFraction: number = DEVTOOLS_PANEL.defaultFraction;
  private readonly devtoolsListeners = new Set<(fraction: number, committed: boolean) => void>();
  readonly devtoolsSplitter = new Gtk.Box();
  readonly devtoolsDrag = new Gtk.GestureDrag();
  private devtoolsDragStartY = 0;
  private devtoolsDragStartPointerY: number | null = null;
  /** The line along a docked Web Inspector's edge; see InspectorFrame. */
  private readonly inspectorEdge = new Gtk.Box();
  private inspectorEdgeRect: EdgeRect | null = null;

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

    this.stack.set_visible(false);
    this.dragHandle.set_halign(Gtk.Align.FILL);
    this.dragHandle.set_valign(Gtk.Align.START);
    this.controls.add_css_class('ws-controls');
    this.controls.set_halign(Gtk.Align.END);
    this.controls.set_valign(Gtk.Align.START);

    // The page area and the side panel are placed by the overlay's own child-position signal, so
    // they follow the window size (and the 50/50 split) without any timers.
    this.overlay.connect('get-child-position', (_overlay, widget, allocation) =>
      this.placeChild(widget, allocation),
    );
    this.setUpSplitter();
    this.setUpDevToolsSplitter();
    this.overlay.set_child(ui);
    this.overlay.add_overlay(this.stack);
    this.overlay.set_clip_overlay(this.stack, true);
    this.overlay.add_overlay(this.dragHandle);
    this.overlay.add_overlay(this.controls);
    this.inspectorEdge.add_css_class('ws-inspector-edge');
    this.inspectorEdge.set_can_target(false);
    this.inspectorEdge.set_visible(false);
    this.overlay.add_overlay(this.inspectorEdge);
    this.window.set_child(this.overlay);
  }

  /** Puts the inspector's edge line where `rect` says, or hides it. */
  setInspectorEdge(rect: EdgeRect | null): void {
    this.inspectorEdgeRect = rect;
    this.inspectorEdge.set_visible(rect !== null);
    this.overlay.queue_resize();
  }

  /** How much of the window's top the browser chrome takes; page views start below it. */
  setChromeHeight(heightPx: number): void {
    this.chromeHeight = Math.ceil(heightPx);
    this.overlay.queue_resize();
  }

  /**
   * A panel that takes the right half of the window, below the chrome, while it is open; the page
   * area shrinks to the left half. It starts closed.
   */
  setSidePanel(panel: Gtk.Widget): void {
    this.sidePanel = panel;
    panel.set_visible(false);
    this.overlay.add_overlay(panel);
    // Added after the panel so it sits on top of it, along the panel's left edge.
    this.overlay.add_overlay(this.splitter);
  }

  setSidePanelOpen(open: boolean): void {
    this.sidePanelOpen = open;
    this.showSidePanel();
    this.overlay.queue_resize();
  }

  isSidePanelOpen(): boolean {
    return this.sidePanelOpen;
  }

  private showSidePanel(): void {
    const shown = this.sidePanelOpen && !this.contentFullscreen && this.sidePanel !== null;
    this.sidePanel?.set_visible(shown);
    this.splitter.set_visible(shown);
  }

  /** Share of the window width the panel takes while it is open (0..1). */
  getSidePanelFraction(): number {
    return this.sidePanelFraction;
  }

  /**
   * Sets how much of the window the panel takes. `committed` means the user is done choosing (the
   * drag ended, or it was set outright), which is when it is worth remembering.
   */
  setSidePanelFraction(fraction: number, committed = true): void {
    if (!Number.isFinite(fraction)) return;
    this.sidePanelFraction = Math.min(0.95, Math.max(0.05, fraction));
    debug(
      'panel',
      `fraction ${this.sidePanelFraction.toFixed(4)}${committed ? ' (committed)' : ''}`,
    );
    this.overlay.queue_resize();
    for (const listener of this.fractionListeners) listener(this.sidePanelFraction, committed);
  }

  onSidePanelFraction(listener: (fraction: number, committed: boolean) => void): () => void {
    this.fractionListeners.add(listener);
    return () => {
      this.fractionListeners.delete(listener);
    };
  }

  /** Width in pixels of the panel, keeping at least a usable width for it and for the page. */
  private panelWidth(windowWidth: number): number {
    const wanted = Math.round(windowWidth * this.sidePanelFraction);
    const most = Math.max(MENU_PANEL.minPanelWidth, windowWidth - MENU_PANEL.minPageWidth);
    return Math.min(most, Math.max(MENU_PANEL.minPanelWidth, wanted));
  }

  /** Where an overlay child goes: the page area and the side panel split the space under the chrome. */
  private placeChild(widget: Gtk.Widget, allocation: Gdk.Rectangle): boolean {
    if (widget === this.inspectorEdge) {
      const rect = this.inspectorEdgeRect;
      if (!rect) return false;
      allocation.x = rect.x;
      allocation.y = rect.y;
      allocation.width = rect.width;
      allocation.height = rect.height;
      return true;
    }
    const isDevTools =
      widget === this.devtoolsSplitter || (widget === this.devtoolsPanel && widget !== null);
    if (
      widget !== this.stack &&
      widget !== this.sidePanel &&
      widget !== this.splitter &&
      !isDevTools
    ) {
      return false;
    }
    const width = this.overlay.get_width();
    const height = this.overlay.get_height();
    const top = this.contentFullscreen ? 0 : this.chromeHeight;
    const split = this.sidePanelOpen && !this.contentFullscreen;
    const panelX = width - this.panelWidth(width);
    const pageWidth = split ? panelX : width;
    const areaHeight = Math.max(0, height - top);
    const devtoolsHeight = this.devtoolsHeight(areaHeight);
    allocation.y = top;
    allocation.height = areaHeight;
    if (isDevTools) {
      // Under the page, as wide as the page (the menu panel keeps its side).
      allocation.x = 0;
      allocation.width = pageWidth;
      allocation.y = top + areaHeight - devtoolsHeight;
      allocation.height =
        widget === this.devtoolsSplitter ? DEVTOOLS_PANEL.splitterHeight : devtoolsHeight;
    } else if (widget === this.stack) {
      allocation.x = 0;
      allocation.width = pageWidth;
      allocation.height = Math.max(0, areaHeight - devtoolsHeight);
    } else if (widget === this.sidePanel) {
      allocation.x = panelX;
      allocation.width = width - panelX;
    } else {
      // Inside the panel's edge, so a Chrome window embedded in the page area never covers it.
      allocation.x = panelX;
      allocation.width = MENU_PANEL.splitterWidth;
    }
    return true;
  }

  /** Shows `panel` under the page (or none): one panel at a time, each added to the overlay once. */
  setDevToolsPanel(panel: Gtk.Widget | null): void {
    if (this.devtoolsPanel === panel) return;
    this.devtoolsPanel?.set_visible(false);
    this.devtoolsPanel = panel;
    if (panel && panel.get_parent() !== this.overlay) {
      this.overlay.add_overlay(panel);
      this.overlay.set_clip_overlay(panel, true);
      // Above the panel, along its top edge.
      this.overlay.remove_overlay(this.devtoolsSplitter);
      this.overlay.add_overlay(this.devtoolsSplitter);
    }
    panel?.set_visible(!this.contentFullscreen);
    this.devtoolsSplitter.set_visible(panel !== null && !this.contentFullscreen);
    this.overlay.queue_resize();
  }

  /** Takes a panel that will not be shown again out of the window. */
  removeDevToolsPanel(panel: Gtk.Widget): void {
    if (this.devtoolsPanel === panel) this.setDevToolsPanel(null);
    if (panel.get_parent() === this.overlay) this.overlay.remove_overlay(panel);
  }

  getDevToolsFraction(): number {
    return this.devtoolsFraction;
  }

  /** How much of the page area the panel takes (0.1..0.9); `committed` when the user is done. */
  setDevToolsFraction(fraction: number, committed = true): void {
    if (!Number.isFinite(fraction)) return;
    this.devtoolsFraction = Math.min(0.9, Math.max(0.1, fraction));
    this.overlay.queue_resize();
    for (const listener of this.devtoolsListeners) listener(this.devtoolsFraction, committed);
  }

  onDevToolsFraction(listener: (fraction: number, committed: boolean) => void): () => void {
    this.devtoolsListeners.add(listener);
    return () => {
      this.devtoolsListeners.delete(listener);
    };
  }

  /** Pixels the panel takes of a page area `areaHeight` tall; 0 while no panel shows. */
  private devtoolsHeight(areaHeight: number): number {
    if (this.devtoolsPanel === null || this.contentFullscreen) return 0;
    const most = Math.max(DEVTOOLS_PANEL.minPanelHeight, areaHeight - DEVTOOLS_PANEL.minPageHeight);
    const wanted = Math.round(areaHeight * this.devtoolsFraction);
    return Math.min(most, Math.max(DEVTOOLS_PANEL.minPanelHeight, wanted));
  }

  /** The bar on the panel's top edge: drag to resize, double-click to go back to the default. */
  private setUpDevToolsSplitter(): void {
    this.devtoolsSplitter.add_css_class('ws-devtools-splitter');
    this.devtoolsSplitter.set_cursor_from_name('row-resize');
    this.devtoolsSplitter.set_visible(false);
    this.devtoolsSplitter.add_controller(this.devtoolsDrag);
    this.overlay.add_overlay(this.devtoolsSplitter);
    const pointerY = (gesture: Gtk.Gesture): number | null => {
      const [known, , y] = gesture.get_current_event()?.get_position() ?? [false, 0, 0];
      return known ? y : null;
    };
    const areaHeight = (): number =>
      Math.max(0, this.overlay.get_height() - (this.contentFullscreen ? 0 : this.chromeHeight));
    this.devtoolsDrag.connect('drag-begin', (gesture) => {
      const area = areaHeight();
      this.devtoolsDragStartY = area - this.devtoolsHeight(area);
      this.devtoolsDragStartPointerY = pointerY(gesture);
      this.devtoolsSplitter.add_css_class('ws-dragging');
    });
    this.devtoolsDrag.connect('drag-update', (gesture, _offsetX, offsetY) => {
      const area = areaHeight();
      if (area <= 0) return;
      const now = pointerY(gesture);
      const moved =
        now !== null && this.devtoolsDragStartPointerY !== null
          ? now - this.devtoolsDragStartPointerY
          : offsetY;
      this.setDevToolsFraction(1 - (this.devtoolsDragStartY + moved) / area, false);
    });
    this.devtoolsDrag.connect('drag-end', () => {
      this.devtoolsDragStartPointerY = null;
      this.devtoolsSplitter.remove_css_class('ws-dragging');
      this.setDevToolsFraction(this.devtoolsFraction, true);
    });
    const doubleClick = new Gtk.GestureClick();
    doubleClick.connect('pressed', (_gesture, presses) => {
      if (presses === 2) this.setDevToolsFraction(DEVTOOLS_PANEL.defaultFraction, true);
    });
    this.devtoolsSplitter.add_controller(doubleClick);
  }

  /** The bar along the panel's left edge: drag to resize, double-click to go back to half. */
  private setUpSplitter(): void {
    this.splitter.add_css_class('ws-splitter');
    this.splitter.set_cursor_from_name('col-resize');
    this.splitter.set_visible(false);
    this.splitter.add_controller(this.splitterDrag);
    // The gesture's own offset is measured in the splitter's coordinates, and the splitter moves
    // with the pointer, which made the bar jitter. The pointer's position in the window's surface
    // coordinates does not depend on where the bar is, so the drag is measured with that.
    const pointerX = (gesture: Gtk.Gesture): number | null => {
      const [known, x] = gesture.get_current_event()?.get_position() ?? [false, 0];
      return known ? x : null;
    };
    this.splitterDrag.connect('drag-begin', (gesture) => {
      const width = this.overlay.get_width();
      this.dragStartPanelX = width - this.panelWidth(width);
      this.dragStartPointerX = pointerX(gesture);
      this.splitter.add_css_class('ws-dragging');
    });
    this.splitterDrag.connect('drag-update', (gesture, offsetX) => {
      const width = this.overlay.get_width();
      if (width <= 0) return;
      const now = pointerX(gesture);
      const moved =
        now !== null && this.dragStartPointerX !== null ? now - this.dragStartPointerX : offsetX;
      this.setSidePanelFraction(1 - (this.dragStartPanelX + moved) / width, false);
    });
    this.splitterDrag.connect('drag-end', () => {
      this.dragStartPointerX = null;
      this.splitter.remove_css_class('ws-dragging');
      this.setSidePanelFraction(this.sidePanelFraction, true);
    });
    const doubleClick = new Gtk.GestureClick();
    doubleClick.connect('pressed', (_gesture, presses) => {
      if (presses === 2) this.setSidePanelFraction(MENU_PANEL.defaultFraction, true);
    });
    this.splitter.add_controller(doubleClick);
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
    this.contentFullscreen = fullscreen;
    this.showSidePanel();
    this.overlay.queue_resize();
    this.controls.set_visible(!fullscreen);
    this.dragHandle.set_visible(!fullscreen);
    if (fullscreen) this.window.fullscreen();
    else this.window.unfullscreen();
  }
}
