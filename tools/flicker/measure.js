// Renders the WebView widget to an image on every frame while a page scrolls by itself, and checks
// that a fixed header stays exactly where it is and that the text does not disappear.
// Usage (from the repository root): gjs -m tools/flicker/measure.js plain|overlay [seconds]
imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Gdk = '4.0';
imports.gi.versions.WebKit = '6.0';
const { Gtk, Gdk, WebKit, GLib, Gio } = imports.gi;

const variant = ARGV[0] ?? 'plain';
const seconds = Number(ARGV[1] ?? 8);
const HEADER_HEIGHT = 64;
const HEADER = [200, 0, 0]; // R, G, B of the fixed header in fixed-header.html
const page = GLib.filename_to_uri(
  GLib.build_filenamev([GLib.get_current_dir(), 'tools', 'flicker', 'fixed-header.html']),
  null,
);

const app = new Gtk.Application({
  application_id: 'dev.webswitch.flicker.measure',
  flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
  const window = new Gtk.ApplicationWindow({
    application: app,
    default_width: 1280,
    default_height: 800,
    title: `measure (${variant})`,
  });
  const view = new WebKit.WebView();
  view.load_uri(page);
  if (variant === 'overlay') {
    const ui = new WebKit.WebView();
    ui.load_html('<body style="margin:0;background:#000"></body>', 'about:blank');
    const stack = new Gtk.Stack({ hexpand: true, vexpand: true });
    stack.add_named(view, '1');
    const overlay = new Gtk.Overlay();
    overlay.set_child(ui);
    overlay.add_overlay(stack);
    overlay.set_clip_overlay(stack, true);
    overlay.connect('get-child-position', (_o, widget, a) => {
      if (widget !== stack) return false;
      a.x = 0;
      a.y = 112;
      a.width = overlay.get_width();
      a.height = Math.max(0, overlay.get_height() - 112);
      return true;
    });
    window.set_child(overlay);
  } else {
    window.set_child(view);
  }
  window.present();

  const paintable = Gtk.WidgetPaintable.new(view);
  const presented = [];
  let lastPresentation = 0;
  let lastCounter = 0;
  let refreshUs = 0;
  const stats = { frames: 0, headerBad: 0, textMissing: 0, blank: 0, samples: [] };
  let started = 0;
  view.add_tick_callback(() => {
    const now = GLib.get_monotonic_time();
    if (started === 0) started = now;
    const elapsed = (now - started) / 1e6;
    // When each frame really reached the screen, as reported by the compositor.
    const clock = view.get_frame_clock();
    const counter = clock.get_frame_counter();
    if (elapsed > 2 && counter - 3 > lastCounter) {
      lastCounter = counter - 3;
      const timings = clock.get_timings(lastCounter);
      if (timings && timings.get_complete()) {
        const at = timings.get_presentation_time();
        refreshUs = timings.get_refresh_interval() || refreshUs;
        if (at !== 0 && lastPresentation !== 0) presented.push((at - lastPresentation) / 1000);
        if (at !== 0) lastPresentation = at;
      }
    }
    const w = view.get_width(),
      h = view.get_height();
    if (elapsed > 2 && w > 0 && h > 0) {
      const snapshot = Gtk.Snapshot.new();
      paintable.snapshot(snapshot, w, h);
      const node = snapshot.to_node();
      const texture = node ? view.get_native().get_renderer().render_texture(node, null) : null;
      if (texture) {
        const [bytes, stride] = Gdk.TextureDownloader.new(texture).download_bytes();
        const data = bytes.get_data();
        const px = (x, y) => {
          const o = y * stride + x * 4;
          return [data[o + 2], data[o + 1], data[o]];
        };
        stats.frames++;
        // The header: every sampled pixel in its rows must be the header color; and the row just below it must not be.
        const isHeader = (p) => Math.abs(p[0] - HEADER[0]) < 12 && p[1] < 30 && p[2] < 30;
        let headerOk = true;
        for (const y of [0, 20, 40, HEADER_HEIGHT - 2])
          for (const x of [10, w >> 1, w - 10]) if (!isHeader(px(x, y))) headerOk = false;
        for (const x of [10, w >> 1, w - 10])
          if (isHeader(px(x, HEADER_HEIGHT + 3))) headerOk = false;
        if (!headerOk) stats.headerBad++;
        // The text: the share of dark pixels in a band under the header should never collapse.
        let dark = 0,
          total = 0;
        for (let y = HEADER_HEIGHT + 20; y < h - 10; y += 6)
          for (let x = 40; x < w - 40; x += 6) {
            const p = px(x, y);
            total++;
            if (p[0] < 110 && p[1] < 110 && p[2] < 110) dark++;
          }
        stats.samples.push(dark / total);
        if (total > 0 && dark === 0) stats.blank++;
      }
    }
    if (elapsed > seconds) {
      const s = stats.samples.slice().sort((a, b) => a - b);
      const median = s[s.length >> 1] ?? 0;
      stats.textMissing = s.filter((v) => v < median * 0.3).length;
      print(`[${variant}] frames checked: ${stats.frames}`);
      print(
        `[${variant}] header out of place or altered: ${stats.headerBad} (${((100 * stats.headerBad) / Math.max(1, stats.frames)).toFixed(1)}%)`,
      );
      print(
        `[${variant}] frames where the text (almost) disappeared: ${stats.textMissing} (${((100 * stats.textMissing) / Math.max(1, stats.frames)).toFixed(1)}%), completely blank: ${stats.blank}`,
      );
      print(
        `[${variant}] typical text density ${median.toFixed(3)} (min ${(s[0] ?? 0).toFixed(3)})`,
      );
      const d = presented.slice().sort((a, b) => a - b);
      const pick = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))] ?? 0;
      const refresh = refreshUs / 1000;
      const late = d.filter((v) => refresh > 0 && v > refresh * 1.5).length;
      print(
        `[${variant}] frames presented (reported by the compositor): ${d.length}, screen refresh ${refresh.toFixed(1)} ms`,
      );
      print(
        `[${variant}] time between presented frames: median ${pick(0.5).toFixed(1)} ms, 95% ${pick(0.95).toFixed(1)} ms, worst ${(d[d.length - 1] ?? 0).toFixed(1)} ms`,
      );
      print(
        `[${variant}] frames that missed a refresh (>1.5x): ${late} (${((100 * late) / Math.max(1, d.length)).toFixed(1)}%)`,
      );
      app.quit();
      return GLib.SOURCE_REMOVE;
    }
    return GLib.SOURCE_CONTINUE;
  });
});
app.run([]);
