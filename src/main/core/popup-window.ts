import Gtk from 'gi://Gtk?version=4.0';
import type WebKit from 'gi://WebKit?version=6.0';

/**
 * A page's popup (`window.open` with a size, the shape of every OAuth sign-in) in a small window of
 * its own. The web view stays linked to the page that opened it, so the sign-in can hand its
 * result back. No title bar: just a close button over the top-right corner, and a border in the
 * theme's main color on every side.
 */
export function openPopupWindow(parent: Gtk.Window, view: WebKit.WebView): void {
  const geometry = view.get_window_properties().get_geometry();
  const window = new Gtk.Window({
    transient_for: parent,
    default_width: geometry.width > 0 ? geometry.width : 480,
    default_height: geometry.height > 0 ? geometry.height : 640,
  });
  window.add_css_class('ws-window');
  const noTitleBar = new Gtk.Box();
  noTitleBar.set_visible(false);
  window.set_titlebar(noTitleBar);

  const close = Gtk.Button.new_from_icon_name('window-close-symbolic');
  close.add_css_class('ws-popup-close');
  close.set_halign(Gtk.Align.END);
  close.set_valign(Gtk.Align.START);
  close.connect('clicked', () => {
    window.close();
  });
  view.connect('close', () => {
    window.close();
  });

  const overlay = new Gtk.Overlay();
  overlay.set_child(view);
  overlay.add_overlay(close);
  // The theme's main color on every side (the window has no title bar to frame it).
  const frame = new Gtk.Box();
  frame.add_css_class('ws-frame');
  overlay.set_hexpand(true);
  overlay.set_vexpand(true);
  frame.append(overlay);
  window.set_child(frame);
  window.present();
}
