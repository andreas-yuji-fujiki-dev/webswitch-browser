// Opens a real site, scrolls it by itself and watches the top band of the window (where a fixed
// header lives) on every frame. A steady header gives the same band every time; flicker shows up as
// frames whose band differs from the usual one.
// Usage (from the repository root): gjs -m tools/flicker/site.js <url> [plain|overlay] [seconds] [out-dir]
imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Gdk = '4.0';
imports.gi.versions.WebKit = '6.0';
const { Gtk, Gdk, WebKit, GLib, Gio } = imports.gi;

const url = ARGV[0] ?? 'https://laracasts.com';
const variant = ARGV[1] ?? 'plain';
const seconds = Number(ARGV[2] ?? 12);
const outDir = ARGV[3] ?? '/tmp';
const BAND = 96; // rows from the top of the page area that are compared
const SCROLL = `(() => { let y = 0, dir = 1; const step = () => { const max = Math.max(0, document.documentElement.scrollHeight - innerHeight); y += dir * 70; if (y > max || y < 0) { dir *= -1; y = Math.max(0, Math.min(y, max)); } window.scrollTo(0, y); requestAnimationFrame(step); }; requestAnimationFrame(step); return document.documentElement.scrollHeight; })()`;

const app = new Gtk.Application({
  application_id: 'dev.webswitch.flicker.site',
  flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
  const window = new Gtk.ApplicationWindow({
    application: app,
    default_width: 1280,
    default_height: 800,
    title: `site (${variant}): ${url}`,
  });
  const view = new WebKit.WebView({ network_session: WebKit.NetworkSession.new_ephemeral() });
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
  view.load_uri(url);

  const paintable = Gtk.WidgetPaintable.new(view);
  let scrolling = false,
    startedAt = 0,
    title = '';
  const signatures = new Map(); // band signature -> how many frames had it
  const frames = []; // { signature, texture? }
  let saved = 0;
  view.connect('notify::title', () => {
    title = view.get_title() ?? '';
  });
  view.connect('load-changed', (_v, event) => {
    if (event !== WebKit.LoadEvent.FINISHED || scrolling) return;
    // Give the page a few seconds to settle (scripts, banners), then scroll.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
      view.evaluate_javascript(SCROLL, -1, null, null, null, () => {});
      scrolling = true;
      startedAt = GLib.get_monotonic_time();
      return GLib.SOURCE_REMOVE;
    });
  });

  const signatureOf = (data, stride, w) => {
    const values = [];
    for (let y = 0; y < BAND; y += 4)
      for (let x = 8; x < w - 8; x += 20) {
        const o = y * stride + x * 4;
        values.push((data[o + 2] >> 3) | ((data[o + 1] >> 3) << 5) | ((data[o] >> 3) << 10));
      }
    return values;
  };
  const distance = (a, b) => {
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d / a.length;
  };

  view.add_tick_callback(() => {
    const now = GLib.get_monotonic_time();
    const w = view.get_width(),
      h = view.get_height();
    if (scrolling && w > 0 && h > 0) {
      const snapshot = Gtk.Snapshot.new();
      paintable.snapshot(snapshot, w, h);
      const node = snapshot.to_node();
      const texture = node ? view.get_native().get_renderer().render_texture(node, null) : null;
      if (texture) {
        const [bytes, stride] = Gdk.TextureDownloader.new(texture).download_bytes();
        const values = signatureOf(bytes.get_data(), stride, w);
        frames.push({ values, texture: frames.length % 25 === 0 ? texture : null });
      }
      if ((now - startedAt) / 1e6 > seconds) {
        // The usual band is the one most frames share (compared with a small tolerance).
        const groups = [];
        for (const f of frames) {
          const g = groups.find((c) => distance(c.values, f.values) < 0.02);
          if (g) g.count++;
          else groups.push({ values: f.values, count: 1, sample: f });
        }
        groups.sort((a, b) => b.count - a.count);
        const usual = groups[0];
        const off = frames.filter((f) => distance(usual.values, f.values) >= 0.02);
        const worst = off.reduce((m, f) => Math.max(m, distance(usual.values, f.values)), 0);
        print(`[${variant}] page: "${title}"`);
        print(`[${variant}] frames watched: ${frames.length}`);
        print(
          `[${variant}] top band differs from its usual look in ${off.length} frames (${((100 * off.length) / Math.max(1, frames.length)).toFixed(1)}%), worst difference ${(100 * worst).toFixed(0)}% of the sampled pixels`,
        );
        print(
          `[${variant}] different looks of the band: ${groups.length} (the biggest has ${((100 * usual.count) / Math.max(1, frames.length)).toFixed(0)}% of the frames)`,
        );
        const tag = url.replace(/[^a-z0-9]+/gi, '_').slice(0, 30);
        const keep = frames.find((f) => f.texture);
        if (keep) keep.texture.save_to_png(`${outDir}/${tag}-${variant}-normal.png`);
        const bad = off.find((f) => f.texture) ?? off[0];
        if (bad && bad.texture) bad.texture.save_to_png(`${outDir}/${tag}-${variant}-odd.png`);
        app.quit();
        return GLib.SOURCE_REMOVE;
      }
    }
    return GLib.SOURCE_CONTINUE;
  });
  // Safety net: do not hang if the site never finishes loading.
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, (seconds + 40) * 1000, () => {
    print('timed out');
    app.quit();
    return GLib.SOURCE_REMOVE;
  });
});
app.run([]);
