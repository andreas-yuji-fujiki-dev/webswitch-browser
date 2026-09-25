import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import type WebKit from 'gi://WebKit?version=6.0';
import type { Unsubscribe } from '~types/common';
import type { MenuAnchor, MenuItemId, MenuSize, MenuState } from '~types/menu';

// Used only until the menu view reports its real size.
const INITIAL_SIZE: MenuSize = { width: 54, height: 230 };
const GAP = 4;
// Clicking the button that opened the menu first closes it (a click outside), then fires the
// click; without this guard the same click would open it again.
const REOPEN_GUARD_US = 250_000;

/**
 * The dropdown menu is a popover holding its own small web view (the same bundled UI, loaded with
 * `?view=menu`). A popover floats above everything, page views included, and closes itself when
 * the user clicks anywhere else.
 */
export class MenuService {
  private readonly popover = new Gtk.Popover();
  private readonly holder = new Gtk.ScrolledWindow({
    hscrollbar_policy: Gtk.PolicyType.NEVER,
    vscrollbar_policy: Gtk.PolicyType.NEVER,
    propagate_natural_width: false,
    propagate_natural_height: false,
  });
  private readonly listeners = new Set<(state: MenuState) => void>();
  private readonly selectListeners = new Set<(itemId: MenuItemId) => void>();
  private anchor: MenuAnchor = { right: 0, bottom: 0 };
  private size: MenuSize = INITIAL_SIZE;
  private closedAt = 0;

  constructor(
    parent: Gtk.Widget,
    private readonly view: WebKit.WebView,
  ) {
    // A web view reports a natural size as big as the window, and a popover takes its child's
    // natural size. The holder pins the popover to exactly the size of the menu's icons.
    this.holder.set_child(view);
    this.applySize();
    this.popover.add_css_class('ws-menu');
    this.popover.set_has_arrow(false);
    this.popover.set_autohide(true);
    this.popover.set_position(Gtk.PositionType.BOTTOM);
    this.popover.set_child(this.holder);
    this.popover.set_parent(parent);
    this.popover.connect('closed', () => {
      this.closedAt = GLib.get_monotonic_time();
      this.emitState();
    });
  }

  onStateChanged(listener: (state: MenuState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onSelect(listener: (itemId: MenuItemId) => void): Unsubscribe {
    this.selectListeners.add(listener);
    return () => {
      this.selectListeners.delete(listener);
    };
  }

  select(itemId: MenuItemId): void {
    this.close();
    for (const listener of this.selectListeners) listener(itemId);
  }

  toggle(anchor: MenuAnchor): void {
    if (this.popover.get_visible()) {
      this.close();
    } else if (GLib.get_monotonic_time() - this.closedAt > REOPEN_GUARD_US) {
      this.anchor = anchor;
      this.place();
      this.popover.popup();
      this.emitState();
    }
  }

  isOpen(): boolean {
    return this.popover.get_visible();
  }

  close(): void {
    if (this.popover.get_visible()) this.popover.popdown();
  }

  setSize(size: MenuSize): void {
    if (!(size.width > 0 && size.height > 0)) return;
    this.size = { width: Math.ceil(size.width), height: Math.ceil(size.height) };
    this.applySize();
    if (this.popover.get_visible()) this.place();
  }

  private applySize(): void {
    this.holder.set_min_content_width(this.size.width);
    this.holder.set_min_content_height(this.size.height);
    this.view.set_size_request(this.size.width, this.size.height);
  }

  /** A popover centres on the rectangle it points at, so give it one as wide as the menu. */
  private place(): void {
    this.popover.set_pointing_to(
      new Gdk.Rectangle({
        x: Math.round(this.anchor.right - this.size.width),
        y: Math.round(this.anchor.bottom + GAP),
        width: this.size.width,
        height: 1,
      }),
    );
  }

  private emitState(): void {
    const state: MenuState = { open: this.popover.get_visible() };
    for (const listener of this.listeners) listener(state);
  }
}
