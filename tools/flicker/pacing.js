// Baseline: how evenly does this machine present frames for a plain GTK window (no WebKit) that
// redraws on every frame? Usage: gjs -m tools/flicker/pacing.js [seconds]
imports.gi.versions.Gtk = '4.0';
const { Gtk, GLib, Gio } = imports.gi;
const seconds = Number(ARGV[0] ?? 8);
const app = new Gtk.Application({
  application_id: 'dev.webswitch.flicker.pacing',
  flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
  const window = new Gtk.ApplicationWindow({
    application: app,
    default_width: 1280,
    default_height: 800,
    title: 'pacing baseline (no WebKit)',
  });
  const area = new Gtk.DrawingArea({ hexpand: true, vexpand: true });
  let x = 0;
  area.set_draw_func((_a, cr, w, h) => {
    cr.setSourceRGB(0.1, 0.1, 0.1);
    cr.paint();
    cr.setSourceRGB(0.9, 0.4, 0.5);
    cr.rectangle(x % (w - 80), h / 2 - 40, 80, 80);
    cr.fill();
  });
  window.set_child(area);
  window.present();
  const presented = [];
  let lastPresentation = 0,
    lastCounter = 0,
    refreshUs = 0,
    started = 0;
  area.add_tick_callback(() => {
    const now = GLib.get_monotonic_time();
    if (started === 0) started = now;
    const elapsed = (now - started) / 1e6;
    x += 14;
    area.queue_draw();
    const clock = area.get_frame_clock();
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
    if (elapsed > seconds) {
      const d = presented.slice().sort((a, b) => a - b);
      const pick = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))] ?? 0;
      const refresh = refreshUs / 1000;
      const late = d.filter((v) => refresh > 0 && v > refresh * 1.5).length;
      print(`[gtk only] frames presented: ${d.length}, screen refresh ${refresh.toFixed(1)} ms`);
      print(
        `[gtk only] time between presented frames: median ${pick(0.5).toFixed(1)} ms, 95% ${pick(0.95).toFixed(1)} ms, worst ${(d[d.length - 1] ?? 0).toFixed(1)} ms`,
      );
      print(
        `[gtk only] frames that missed a refresh (>1.5x): ${late} (${((100 * late) / Math.max(1, d.length)).toFixed(1)}%)`,
      );
      app.quit();
      return GLib.SOURCE_REMOVE;
    }
    return GLib.SOURCE_CONTINUE;
  });
});
app.run([]);
