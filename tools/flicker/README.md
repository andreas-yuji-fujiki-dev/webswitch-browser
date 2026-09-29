# Flicker test

Two minimal browsers to find out whether text flickering while scrolling comes from WebKit and the graphics driver, or from Webswitch's own window layout. Run them **from the repository root**, scroll the text fast with the mouse wheel, and compare with Webswitch itself.

```sh
gjs -m tools/flicker/plain.js     # A: one WebView in one window
gjs -m tools/flicker/overlay.js   # B: Webswitch's layout (a WebView over a WebView in a Gtk.Overlay)
```

- If **A** flickers too, it is WebKit and the graphics setup, not Webswitch.
- If **A** does not flicker but **B** does, the layout is the cause.
- The same environment variables work on all three, for example `WEBKIT_DISABLE_DMABUF_RENDERER=1 gjs -m tools/flicker/plain.js`.

## Measuring tools

```sh
gjs -m tools/flicker/measure.js plain|overlay [seconds]   # per-frame header/text check and compositor presentation timing
gjs -m tools/flicker/pacing.js [seconds]                  # the same timing for a plain GTK window without WebKit
```

`measure.js` scrolls `fixed-header.html` by itself and renders the WebView widget to an image on every frame. `pacing.js` is the baseline: if it is even and `measure.js` is not, the unevenness comes from WebKit.

## Result

On the author's 144 Hz laptop the defect showed in a bare WebView too. `hardware_acceleration_policy = NEVER` stopped it; `enable_smooth_scrolling = false` reduced it but not fully. The measuring tools above could not see it; a bare WebView per window with one setting changed, scrolled by hand, could.
