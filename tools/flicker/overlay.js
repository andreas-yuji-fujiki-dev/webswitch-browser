// Flicker test (see tools/flicker/README.md). Scroll the text fast with the mouse wheel.
imports.gi.versions.Gtk = '4.0';
imports.gi.versions.WebKit = '6.0';
const { Gtk, WebKit, GLib, Gio } = imports.gi;
const page = GLib.filename_to_uri(
  GLib.build_filenamev([GLib.get_current_dir(), 'tools', 'flicker', 'long.html']),
  null,
);

// B: the same layout as Webswitch: a full-window WebView (the UI) with the page WebView on top of it, in a Gtk.Stack inside a Gtk.Overlay, placed below a 112 px strip.
const app = new Gtk.Application({
  application_id: 'dev.webswitch.flicker.overlay',
  flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
  const window = new Gtk.ApplicationWindow({
    application: app,
    default_width: 1280,
    default_height: 800,
    title: 'B: WebView over WebView (Webswitch layout)',
  });
  const ui = new WebKit.WebView();
  ui.load_html(
    '<body style="margin:0;background:#000;color:#e8adb9;font:16px sans-serif"><p style="padding:24px">the UI view (tab strip and toolbar)</p>',
    'about:blank',
  );
  const stack = new Gtk.Stack({ hexpand: true, vexpand: true });
  const pageView = new WebKit.WebView();
  pageView.load_uri(page);
  stack.add_named(pageView, '1');
  const overlay = new Gtk.Overlay();
  overlay.set_child(ui);
  overlay.add_overlay(stack);
  overlay.set_clip_overlay(stack, true);
  overlay.connect('get-child-position', (_overlay, widget, allocation) => {
    if (widget !== stack) return false;
    allocation.x = 0;
    allocation.y = 112;
    allocation.width = overlay.get_width();
    allocation.height = Math.max(0, overlay.get_height() - 112);
    return true;
  });
  window.set_child(overlay);
  window.present();
});
app.run([]);
