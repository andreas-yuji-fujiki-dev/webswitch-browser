// A minimal browser that reports how evenly its window presents frames WHILE THE MOUSE WHEEL TURNS,
// with the same measuring as Webswitch's own probe, so the two can be compared with the same input.
// Usage (from the repository root): gjs -m tools/flicker/watch.js <url> [plain|overlay]
imports.gi.versions.Gtk = '4.0';
imports.gi.versions.WebKit = '6.0';
const { Gtk, WebKit, GLib, Gio } = imports.gi;

const url = ARGV[0] ?? 'https://laracasts.com';
const variant = ARGV[1] ?? 'plain';
const app = new Gtk.Application({
  application_id: 'dev.webswitch.flicker.watch',
  flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
  const window = new Gtk.ApplicationWindow({
    application: app,
    default_width: 1280,
    default_height: 800,
    title: `watch (${variant}): ${url}`,
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

  const t0 = GLib.get_monotonic_time();
  const at = () => `${((GLib.get_monotonic_time() - t0) / 1e6).toFixed(1)}s`;
  let lastScroll = 0,
    scrollEvents = 0,
    lastCounter = 0,
    lastPresented = 0,
    refreshUs = 0;
  const windowGaps = [],
    allGaps = [];
  const wheel = Gtk.EventControllerScroll.new(Gtk.EventControllerScrollFlags.BOTH_AXES);
  wheel.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
  wheel.connect('scroll', () => {
    lastScroll = GLib.get_monotonic_time();
    scrollEvents++;
    return false;
  });
  window.add_controller(wheel);
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8, () => {
    const c = window.get_frame_clock();
    if (!c) return GLib.SOURCE_CONTINUE;
    const counter = c.get_frame_counter();
    while (lastCounter < counter - 3) {
      lastCounter++;
      const timings = c.get_timings(lastCounter);
      if (timings && timings.get_complete()) {
        const presented = timings.get_presentation_time();
        refreshUs = timings.get_refresh_interval() || refreshUs;
        if (
          presented !== 0 &&
          lastPresented !== 0 &&
          GLib.get_monotonic_time() - lastScroll < 250000
        ) {
          const gap = (presented - lastPresented) / 1000;
          windowGaps.push(gap);
          allGaps.push(gap);
        }
        if (presented !== 0) lastPresented = presented;
      }
    }
    return GLib.SOURCE_CONTINUE;
  });
  const describe = (gaps) => {
    const s = gaps.slice().sort((a, b) => a - b);
    const q = (f) => s[Math.min(s.length - 1, Math.floor(s.length * f))] ?? 0;
    const refresh = refreshUs / 1000;
    const late = s.filter((v) => refresh > 0 && v > refresh * 2.5).length;
    return `${s.length} frames, median gap ${q(0.5).toFixed(1)} ms, 95% ${q(0.95).toFixed(1)} ms, worst ${(s[s.length - 1] ?? 0).toFixed(1)} ms, late by >2.5 refreshes: ${late} (${((100 * late) / Math.max(1, s.length)).toFixed(0)}%)`;
  };
  GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    if (scrollEvents > 0)
      print(
        `[watch ${variant}] ${at()} WHILE SCROLLING: ${scrollEvents} wheel events, ${describe(windowGaps)}`,
      );
    windowGaps.length = 0;
    scrollEvents = 0;
    return GLib.SOURCE_CONTINUE;
  });
  app.connect('shutdown', () =>
    print(`[watch ${variant}] TOTAL WHILE SCROLLING: ${describe(allGaps)}`),
  );
});
app.run([]);
