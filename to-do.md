# To-do

## P0 — Prove the promise

- [ ] CI (GitHub Actions, Linux runner with WebKitGTK, `xvfb`) that runs `npm run selftest` and `npm run measure` and fails on any non-local connection.
- [ ] Try the real thing by hand: click the ⋮ menu, drag and resize the window, sign in to Google, download a file, put a video in fullscreen. The self-test covers these only with synthetic input or not at all.

## P1 — Core browser features

- [ ] Find in page (Ctrl+F). WebKit has `FindController`; the UI needs a small bar.
- [ ] Downloads: files are saved to the downloads folder without any UI. Add a list, progress and "open folder".
- [ ] Styled context menu for pages (today WebKit's default one shows).
- [ ] Dormant tabs: unload inactive tabs, with an option to pin a tab so it never sleeps.
- [ ] Settings screen to grant permissions per site (`PermissionsService` already has `grant`/`revoke`).
- [ ] Bookmarks. History already works on a local JSON Lines file; move it (and bookmarks) to SQLite if it outgrows that.
- [ ] Choose the search engine in settings; opt-in search suggestions.
- [ ] Unit tests for the services (`url-resolver.ts` is already a pure function).

- [ ] Cookies page: grow the built-in list of known cookies and companies; optionally encrypt the stored copies of disabled cookies.
- [ ] Cookies "only on": cover redirects and scripted navigations (today only typed addresses, clicked links and form posts wait for the cookie to be restored).

## P2 — Ecosystem

- [ ] **Extensions.** WebKitGTK has no WebExtensions API yet (Igalia is porting it to the GTK/WPE ports upstream; GNOME Web's support is partial). Options: follow upstream and adopt it when it lands, or build a small extension host ourselves.
- [ ] **Password manager.** Bitwarden's extension is out of reach for now; a bridge to `bw serve` (the Bitwarden CLI's local API) would give autofill without an extension.
- [ ] **Chrome DevTools.** The WebKit Web Inspector is what we have. Options to evaluate: Chii or chobitsu (Chrome DevTools frontend over a JS agent), or `ios-webkit-debug-proxy`-style bridges.
- [ ] **DRM inside a tab (Netflix, Spotify web, Disney+).** Today these open in a Chromium app window (see README). Playing them in Webswitch itself needs WebKit built with EME plus a Widevine CDM host for the GTK port, which does not exist and needs a Widevine license. Revisit if upstream WebKitGTK ships it.
- [ ] Embedded Chrome tabs (experimental, `WEBSWITCH_EMBED_DRM=1`): verify typing, video and Widevine by hand; route Webswitch's shortcuts while the Chrome window has focus (XGrabKey on the container); replace the Python helper with something that needs no Python; keep the ⋮ menu visible instead of hiding the window.
- [ ] Permissions UI in Webswitch (per site: notifications, camera, microphone ...), applied to both the WebKit tabs and the Chrome used for DRM pages. Today notifications are blocked and passkeys (WebAuthn) are off in that Chrome, with no way to change it.
- [ ] Track page changes inside an embedded Chrome tab (the address and history only know the URL it was opened with).
- [ ] Make the DRM site list editable (a file in `~/.config/webswitch/`) and add a menu action "Open in Chrome app window" for any page.
- [ ] WebAuthn (security keys, passkeys): missing in the engine's GTK port.
- [ ] Spellcheck with dictionaries bundled in the app (never downloaded).
- [ ] Opt-in auto-update, off by default, behind the "Check for updates" button.

## P3 — Distribution

- [ ] `.rpm` package and a Flatpak (which brings its own WebKitGTK version).
- [ ] Other Linux distros: a list of the dependency packages per distro.

## Loose ends

- [ ] The menu items Switch and Check for updates do nothing yet (each waits for its feature).
- [ ] Memory numbers depend on the engine version; re-run `node tools/bench/bench.mjs` after big WebKitGTK updates and refresh [docs/performance.md](docs/performance.md).
