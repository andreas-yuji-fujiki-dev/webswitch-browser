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
- [x] Choose the search engine in settings (done, General settings). [ ] Opt-in search suggestions.
- [ ] Unit tests for the services (`url-resolver.ts` is already a pure function).

- [ ] Cookies page: grow the built-in list of known cookies and companies; optionally encrypt the stored copies of disabled cookies.
- [ ] Cookies "only on": cover redirects and scripted navigations (today only typed addresses, clicked links and form posts wait for the cookie to be restored).

## P2 — Ecosystem

- [x] **Extensions** (off by default): Chrome Web Store install, content scripts/styles (also registered ones), popup/options, storage, ports and messages, tabs/windows/cookies (incl. onChanged)/history (incl. onVisited)/downloads (real, followed to completion)/notifications, context menu, commands, webNavigation, webRequest (observing **and blocking navigations**), `proxy` (with a visible on-screen notice and a Stop button), `userScripts` (its own script world), offscreen documents, `identity.launchWebAuthFlow`, browsingData, sessions, power, search, HTTP login provider, native messaging, Manifest V3 blocking rules **and redirect rules** (see README). Left: blocking/changing a page's own subresource requests (no WebKit hook exists for that, only for the navigation itself), `devtools_page`, per-extension host limits on blocking rules, a real click test of the toolbar buttons, the WebKit context menu popup with an extension item, desktop notifications on screen, verifying the signature of downloaded packages, why `instantiateStreaming` rejects the `.wasm` MIME type from `webswitch-ext://`, a real Bitwarden login with a real account (only tried with a fake one), `identity.launchWebAuthFlow` against a real provider, a real native-messaging host, and a real proxy/Tampermonkey-style extension by hand.
- [ ] Track down the intermittent full-`npm run selftest` GTK layout collapse and the two unpinned `gjs` SIGSEGVs seen 2026-09-27 (both only when running the self-test repeatedly back-to-back; not reproduced in isolation, not traced to any file changed that day — see CLAUDE.md §12).
- [ ] **Password manager.** Bitwarden's extension is out of reach for now; a bridge to `bw serve` (the Bitwarden CLI's local API) would give autofill without an extension.
- [ ] **Chrome DevTools.** The WebKit Web Inspector is what we have. Options to evaluate: Chii or chobitsu (Chrome DevTools frontend over a JS agent), or `ios-webkit-debug-proxy`-style bridges.
- [ ] **DRM inside a tab (Netflix, Spotify web, Disney+).** Today these open in a Chromium app window (see README). Playing them in Webswitch itself needs WebKit built with EME plus a Widevine CDM host for the GTK port, which does not exist and needs a Widevine license. Revisit if upstream WebKitGTK ships it.
- [ ] Embedded Chrome tabs (experimental, `WEBSWITCH_EMBED_DRM=1`): verify typing, video and Widevine by hand; route Webswitch's shortcuts while the Chrome window has focus (XGrabKey on the container); replace the Python helper with something that needs no Python.
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

- [ ] The menu items Switches and Check for updates do nothing yet (each waits for its feature).
- [ ] More settings once there is a feature behind them: a custom search-engine address, color scheme (system/dark/light), default zoom, restoring tabs on start, per-site permissions, WebRTC (WebKitGTK here has it off by default).
- [ ] Memory numbers depend on the engine version; re-run `node tools/bench/bench.mjs` after big WebKitGTK updates and refresh [docs/performance.md](docs/performance.md).
