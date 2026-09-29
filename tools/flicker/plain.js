// Flicker test (see tools/flicker/README.md). Scroll the text fast with the mouse wheel.
imports.gi.versions.Gtk = '4.0';
imports.gi.versions.WebKit = '6.0';
const { Gtk, WebKit, GLib, Gio } = imports.gi;
const page = GLib.filename_to_uri(
  GLib.build_filenamev([GLib.get_current_dir(), 'tools', 'flicker', 'long.html']),
  null,
);

// A: the simplest possible browser: one WebView filling one window.
const app = new Gtk.Application({
  application_id: 'dev.webswitch.flicker.plain',
  flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
  const window = new Gtk.ApplicationWindow({
    application: app,
    default_width: 1280,
    default_height: 800,
    title: 'A: plain WebView',
  });
  const view = new WebKit.WebView();
  view.load_uri(page);
  window.set_child(view);
  window.present();
});
app.run([]);
