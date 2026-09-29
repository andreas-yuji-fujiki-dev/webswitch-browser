import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import type WebKit from 'gi://WebKit?version=6.0';

/**
 * The small popover the star button (and a folder button in the bookmarks bar) opens: a real
 * `Gtk.Popover` over a fresh `WebKit.WebView` loading `webswitch://ui/` with `?view=bookmarks-popup`,
 * the same technique `ExtensionRuntime.openPopup` already uses for an extension's popup — needed
 * because the UI's own page area sits *under* the tab's web view (`MainWindow`'s overlay), so
 * anything the UI draws below the chrome strip would otherwise be covered by the page, not float
 * over it. Closes itself on outside click (a `Gtk.Popover`'s own default), or via `close()`.
 */
export class BookmarksPopup {
  private popover: Gtk.Popover | null = null;

  constructor(
    private readonly anchor: Gtk.Widget,
    private readonly makeView: () => WebKit.WebView,
    /** The view is `router.track`ed to share the UI's script bridge; it must be `untrack`ed
     * before disposal too, or `IpcRouter.emit` keeps calling into the dangling reference forever
     * after -- confirmed to reliably crash the process (a real SIGSEGV) if left out. */
    private readonly untrack: (view: WebKit.WebView) => void,
  ) {}

  open(
    url: string,
    rect: { x: number; y: number; width: number; height: number },
    size: { width: number; height: number },
  ): void {
    this.popover?.popdown();
    const view = this.makeView();
    view.set_size_request(size.width, size.height);
    const popover = new Gtk.Popover();
    popover.set_parent(this.anchor);
    popover.set_position(Gtk.PositionType.BOTTOM);
    popover.set_pointing_to(new Gdk.Rectangle(rect));
    popover.set_child(view);
    popover.connect('closed', () => {
      if (this.popover === popover) this.popover = null;
      this.untrack(view);
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        // Same order as the extension popup's own teardown: let go of the child before disposing
        // it, or GTK's own bookkeeping for the rest of the run gets corrupted.
        popover.set_child(null);
        popover.unparent();
        view.run_dispose();
        return GLib.SOURCE_REMOVE;
      });
    });
    this.popover = popover;
    view.load_uri(url);
    popover.popup();
  }

  close(): void {
    this.popover?.popdown();
  }

  /** For the self-test: a `Gtk.Popover` is a separate surface a window screenshot does not show
   * (the same reason an extension's popup was never seen in one either — see CLAUDE.md), so this
   * is how open/closed is actually checked instead. */
  isOpen(): boolean {
    return this.popover?.get_visible() ?? false;
  }

  /** The popover's own content view, while open; for the self-test to read what it drew. */
  view(): WebKit.WebView | null {
    return this.popover?.get_child() as WebKit.WebView | null;
  }
}
