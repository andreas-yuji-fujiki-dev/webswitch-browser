# CLAUDE.md — Webswitch

Everything a new session needs to work on this project. Read it fully before changing code. When something here disagrees with the code, the code wins: fix this file.

## 1. What this is

**Webswitch** (folder `webswitch-browser`, product name `Webswitch`, version 0.0.1, license **GPL-3.0-only**) is a minimal, private, CSS-stylable web browser for developers on **Linux**. It is written in TypeScript, runs on **GJS** (GNOME's JavaScript runtime) and draws a **GTK 4** window whose pages are **WebKitGTK 6.0** web views (the engine of GNOME Web). The browser's own interface is HTML/CSS/TS in a web view too.

Non-negotiable ideas:

- **Zero network requests of its own.** No telemetry, sync, auto-update, crash reports, search suggestions, dictionary downloads. It only reaches the network when the user navigates. This is measured, not just promised (`docs/privacy.md`, `tools/measure-net.sh`). Never add a background request. Anything that does (for example the Chrome used for DRM pages) must be documented as outside the promise.
- **Minimal.** Tab strip, address bar, Web Inspector, shortcuts, History, Keybindings. Nothing else without the user asking.
- **Styled by the user** through one `user.css` file; every color, size and font of the UI is a CSS custom property in `src/renderer/styles/tokens.css`.
- **Honest about resources.** It is a full engine, so memory is in the range of other browsers. Never claim it is "lighter" than it is; `docs/performance.md` has measured numbers.
- **Google sign-in must work** (many people use Google accounts) **without impersonating Chrome.** It works on WebKitGTK. Do not add user-agent or client-hints spoofing.

## 2. Working with the user

- The user (Andreas) writes and reads **Portuguese**. Talk to them in Portuguese, plainly and directly. Code, comments, commit messages and docs are **English**.
- They are hands-on: they run the browser themselves and report bugs ("deu erro", screenshots, steps). Act on requests; when a decision is really theirs (a trade-off between approaches), give a recommendation, not a survey.
- They rejected, more than once: compiling Firefox or any whole browser, Electron/Chromium as the base, and impersonating Chrome. Do not propose those again as the main path.
- **Report outcomes faithfully.** If a test failed or a step was skipped, say so. Do not claim something works until you saw it work (a screenshot, a log line, a passing check). Separate "verified" from "believed".
- **Never kill processes by name pattern.** `pkill -x gjs` once closed the user's own Webswitch (it is a GJS program too); `pkill -f` with "webswitch" in the pattern killed the tool's own shell. Kill only PIDs you started, or a whole session you created (see §10).
- The user may have their own Webswitch instance open. It holds the app id `dev.webswitch.Webswitch`; a second launch with the same id is forwarded to it and exits at once (see §10). Use `WEBSWITCH_APP_ID` for your own runs.
- Commit or push only when asked. The repo has a single commit ("first commit").

## 3. Run, build, test

Requirements (openSUSE Tumbleweed; other distros need the equivalents): `nodejs`, `npm`, `gjs`, GTK 4 and WebKit 6.0 typelibs, `libwebkitgtk-6_0-4`, `bubblewrap`, `xdg-dbus-proxy` (WebKit's sandbox). Optional: `python3` and Google Chrome (DRM pages, §8).

```sh
npm install
npm start            # build + gjs -m dist/main.js
npm run build        # three Vite builds into dist/
npm run lint         # eslint . (flat config, type-aware)
npm run typecheck    # tsc --noEmit for src and for the Vite configs
npm run format       # prettier --write .
npm run selftest     # opens a real window and drives the browser (see §9)
npm run measure      # zero-request measurement rig (§9)
npm run make         # tarball out/webswitch-<version>-linux.tar.gz
./scripts/install.sh # per-user install (~/.local/share/webswitch/app, ~/.local/bin/webswitch, desktop entry)
bin/webswitch [url|search ...]   # launcher; addresses open as tabs in the running browser
```

`dist/` is generated and git-ignored. After changing code, rebuild before running a browser that loads `dist/`. **A running instance keeps the old code**: tell the user to close and reopen it.

Always run `npm run lint && npm run typecheck` after edits, and `npm run selftest` when behavior changed.

### Environment variables

| Variable                                            | Effect                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEBSWITCH_APP_ID`                                  | Overrides the GApplication id, so a test run does not join the user's open browser.                                                                                                                                                                                                                               |
| `WEBSWITCH_DEBUG=1`                                 | Verbose `[ws] ...` log lines (loads, load failures, crashes, permissions, policy decisions, new windows, downloads, failed/4xx/5xx/TLS resources), the page console on stdout, right click → Inspect on the UI itself. Debug hooks touch the web views; do not assume a bug reproduces identically with them off. |
| `WEBSWITCH_EMBED_DRM=0`                             | Turns off the embedded Chrome tabs (§8). Default is on when possible.                                                                                                                                                                                                                                             |
| `WEBSWITCH_EMBED_SHOT=/x.png`                       | Debug aid: saves what the embedded Chrome window shows, once.                                                                                                                                                                                                                                                     |
| `WEBSWITCH_NO_OPENER=all`                           | Diagnosis: every new window becomes an independent tab (breaks sign-in popups).                                                                                                                                                                                                                                   |
| `WEBSWITCH_SELFTEST_OUT`, `WEBSWITCH_SELFTEST_SITE` | Where the self-test writes screenshots and the URL of its test site.                                                                                                                                                                                                                                              |
| `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`        | WebKit without its sandbox. Only for measurement or debugging, never for normal browsing.                                                                                                                                                                                                                         |

## 4. Repository layout

```
src/
├── @types/           ALL types, interfaces, ambient declarations (only place allowed)
├── shared/           runtime constants used by native side, preload and UI: ipc-channels.ts,
│                     shortcut-actions.ts, accelerator.ts, menu-items.ts. No gi:// imports.
├── main/             the native side (GJS, GTK, WebKit)
│   ├── main.ts       entry: System.exit(runBrowser())
│   ├── selftest.ts   drives the real browser; screenshots; checks
│   ├── core/         bootstrap, window, popup-window, webviews, ipc-router, ui-scheme, ui-ipc,
│   │                 theme, url (GLib.Uri), files, paths, config, downloads, debug,
│   │                 webkit-async, legacy-migration
│   └── features/     <feature>.service.ts (logic) + <feature>.ipc.ts (handlers that call it)
│       account, cookies, drm, history, keybindings, menu, navigation, permissions,
│       shortcuts, tabs, user-css
├── preload/          preload.ts: builds window.browserApi in the UI page
└── renderer/         the browser UI: index.html, core/, features/ (tab-bar, address-bar, menu,
                      history, keybindings, viewport), styles/ (tokens, reset, base)
helpers/x11-embed.py  Xlib helper for embedded Chrome tabs (copied to dist/ by the build)
scripts/              build.mjs, make.mjs, install.sh, selftest.sh
tools/                measure-net.sh, dns-sink.py, analyze-net.py, bench/ (browser comparison)
tests/                serve.py + site/*.html (self-test pages), fake-bin/google-chrome-stable
data/                 desktop entry + icon
docs/                 architecture.md, privacy.md, performance.md
README.md, to-do.md, LICENSE (GPL-3.0 from gnu.org)
```

Files are kebab-case. Vite configs: `vite.common.ts` (aliases), `vite.main.config.ts` (GJS ES module, `gi://` external), `vite.preload.config.ts` (IIFE), `vite.renderer.config.ts` (UI, `base: './'`).

## 5. Hard rules (ESLint enforces most of them)

1. **All `type`, `interface` and ambient declarations live in `src/@types/`.** ESLint `no-restricted-syntax` rejects them anywhere else in `src/`. Inline type annotations and inferred types are fine.
2. **`enum` is banned everywhere.** Use an `as const` object in code and derive the type in `src/@types/`.
3. **Aliases:** `~types/*` → `src/@types/*`, `~shared/*` → `src/shared/*`. Never name an alias `@types` (it collides with npm's `@types/*`).
4. **Boundaries:** the UI (`renderer`) and `preload` never import from `main`, and vice versa; only `@types` and `shared` are shared. Only `main` may import `gi://*`. `shared` never imports `gi://*`.
5. **The native side is the single source of truth.** Tab state lives in `TabsService`; the UI only renders what events tell it and sends commands.
6. **IPC is typed** in `src/@types/ipc.ts` (`IpcInvokeMap`, `IpcEventMap`); channel names are an `as const` object in `src/shared/ipc-channels.ts`. Add both when adding a channel.
7. TypeScript is `strict` with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`. Vanilla CSS only (no framework). Prettier formats everything.
8. In `src/main` the rule `no-unnecessary-condition` is off on purpose: the GTK/WebKit typings declare many nullable results (`get_uri`, `get_title`) as non-null. Two deprecated GTK/GdkX11 calls carry an inline `eslint-disable` with a reason.
9. Match the surrounding code: comment density, naming, idiom. Comments explain _why_.

## 6. Architecture

### Processes and views

One GJS process runs everything native. WebKit spawns its own web/network processes (sandboxed with bubblewrap).

- `MainWindow` (`core/window.ts`): `Gtk.ApplicationWindow` with an invisible custom titlebar (no title bar, but resize edges kept) and a `Gtk.Overlay`: the **UI web view** fills the window; a `Gtk.Stack` with **one web view per tab** sits over it, starting below the browser chrome (`margin_top = chromeHeight`, reported by the UI through a `ResizeObserver`); a `Gtk.WindowHandle` drags the window; `Gtk.WindowControls` draws the system buttons.
- **The UI is served, not loaded from disk:** `webswitch://ui/` is a custom URI scheme (registered on the default context, secure + CORS) that serves `dist/renderer/`. Tabs may not navigate to `webswitch:` URLs.
- **Built-in pages** (`history`, `keybindings`) are drawn by the UI in its own page area while the tab's web view stays hidden.
- **The ⋮ menu** is a `Gtk.Popover` holding a small web view (`?view=menu`) inside a `Gtk.ScrolledWindow` (a web view reports a natural size as big as the window). It shares the UI's web process and script bridge (`related_view` + the same `UserContentManager`).
- **Popups:** a plain link or `window.open(url)` becomes a tab. `window.open` with a size (every OAuth popup) opens a small window with no title bar, only a close button, whose view keeps `window.opener`. WebKit reports 100×100 when no size was asked, which is how the two are told apart. Clicked links with a target open as independent tabs (implicit `noopener`).
- Tab web views have **no script bridge**; only the UI/menu views get the `ipc` message handler. Tab permissions are all denied by default (`PermissionsService`).

### IPC

The UI calls `window.browserApi.*` (built by `src/preload`) → `webkit.messageHandlers.ipc.postMessage` (script message handler with reply) → `IpcRouter.dispatch` → the handler in `features/<x>/<x>.ipc.ts` → the service. Events go back with `IpcRouter.emit` → `window.__wsEmit(channel, payload)`.

Anatomy of "+" (new tab): `tab-bar.ts` click → `api.tabs.create()` → `tabs:create` → `tabs.ipc.ts` → `TabsService.createTab()` → coalesced `scheduleNotify()` → `tabs:state-changed` event → UI re-renders. Keyboard shortcuts skip the IPC steps.

### Features

- **tabs** (`tabs.service.ts`): tab map, active tab, closed-tab stack (reopen), zoom levels, DevTools toggle, failed-load state (`failedUrl`), history hook (`recordVisit` waits 400 ms for the title to settle), popups/new windows (`handleCreate`), embedded DRM tabs (§8). `closeTab` disposes the view on idle.
- **navigation**: `url-resolver.ts` (pure): URL, `host:port`, or a search on DuckDuckGo (`config.ts`, one place to change).
- **shortcuts / keybindings**: `shortcut-actions.ts` is the catalog and defaults (Chrome-like: Ctrl+T/W/Shift+T/L/R/H, Ctrl+Tab, Ctrl+1-9, Alt+←/→, F12, Ctrl+=/-/0). `KeybindingsService` merges user overrides from `keybindings.json` and is the only validator (needs Ctrl/Alt or F-key, no conflicts). `ShortcutsService` uses a capture-phase `Gtk.EventControllerKey` on the window with a 150 ms repeat guard; shortcuts pause while the Keybindings page records a combination.
- **history**: JSON Lines `history.jsonl`; only http(s); same URL within 10 s is not repeated; asynchronous chained writes; page with day grouping, search, remove, clear (two clicks). DRM pages are recorded too.
- **user-css**: `~/.config/webswitch/user.css`, created with commented examples, reloaded on save (`Gio.FileMonitor`).
- **account**: no Webswitch account and no sync. It only checks the local cookie jar for Google session cookies to mark the menu's user icon.
- **cookies** (`features/cookies/`): the user icon opens the built-in `cookies` page. `cookie-catalog.ts` (pure): registrable-domain heuristic, company table with **account panel** URLs (Google, Microsoft, Meta, Apple, Amazon, GitHub, LinkedIn, X, Spotify, Netflix, Dropbox, Reddit, Adobe) and per-company removal warnings, and explanations for well-known cookie names plus name patterns (kind: authentication, security, preferences, analytics, other). `cookies.service.ts`: lists the jar, disables/enables, "only on these sites", removes; keeps copies of disabled/restricted cookies (values included) in `cookie-policies.json` (mode 0600) and puts them back into (or takes them out of) the jar so that `only-on` cookies are present exactly while an open tab is on an allowed site. Restoring happens before the request for typed addresses (`TabsService.loadUrl`) and for clicked links and form posts (a deferred `decide-policy`: the handler returns true and calls `decision.use()` after the async `add_cookie`). **Company rules:** `store.companies[name]` is one rule (`disabled` or `only-on` + sites) for every cookie of a company, now and later: `applyCompanyRules(jar)` (run in `init`, `sync` and `setCompanyPolicy`) gives any cookie without a rule of its own a stored policy with `origin: 'company'`; a rule set on the cookie (`origin: 'cookie'`) wins, and a cookie the user explicitly allowed is listed in `store.exempt` so the company rule does not take it back. `active` removes the company rule and releases its company-origin policies. An `only-on` company rule with no valid site is refused. IPC `cookies:set-company-policy`. Cookie values never reach the UI. IPC: `cookies:get|remove|set-policy|open-account-panel|changed`; `open-account-panel` only opens URLs from the catalog. The UI page is `renderer/features/cookies/cookies-page.ts` (+ `cookies.css`); the page has its own confirmation dialog because the UI view cannot show native ones.
- **menu**: icon-only ⋮ menu: Switch (placeholder), User (opens the Cookies page; a dot marks a Google session), Check updates (placeholder), History, Keybindings.
- **downloads**: saved to the Downloads folder, never overwriting; no UI yet.

### Data locations

`~/.config/webswitch/` (`user.css`, `keybindings.json`), `~/.local/share/webswitch/` (`history.jsonl`, `cookies.sqlite`, `cookie-policies.json`, `web/`, `drm-profile/`), `~/.cache/webswitch/`. On first run, files from the old Electron version in `~/.config/Webswitch/` are copied (never overwritten).

## 7. Design language

Black and pink, no border radius, no title bar, generous spacing ("modernão", not cramped), boxed sharp tabs, black tab and input backgrounds, no gray chrome border, pink accent `#E8ADB9` (dimmed when the address bar is not focused), start page shows a pink `.webswitch` wordmark with the `.web` part dimmed and a blinking `|` (blink only, no typing animation), popups without a title bar. The user's palette: `#000000 #272727 #1A1A1A #1F1F1F #6B6B6B #BCBCBC #EFF3BC #D3D3D3 #E8C95C #63AFC5 #409CB9 #E8ADB9 #8BC98D #B4CDA7 #718F97`. Light/dark follow the desktop (`gtk_application_prefer_dark_theme` is what WebKitGTK reads for `prefers-color-scheme`). Nothing may animate unless visible or in use: a hidden but running CSS animation once made the UI repaint constantly (9 % idle CPU); animations now run only while the state that shows them is active.

## 8. DRM sites (Netflix, Spotify, Disney+ ...)

WebKitGTK here has **no Encrypted Media Extensions** (`navigator.requestMediaKeySystemAccess` does not exist) and no Widevine for the GTK port, so DRM pages cannot play in a WebKit tab. Widevine needs a Google license; Chromium/Chrome and Firefox have one, Epiphany does not. Prebuilt CEF lacks H.264/AAC on Linux and Widevine in CEF has been unreliable; Qt WebEngine cannot be embedded in GTK 4. The chosen solution is **real Google Chrome**, which already has codecs and Widevine.

- `features/drm/drm-sites.ts`: host list (suffix match; a leading `=` means exact host, e.g. `=spotify.com` but not `accounts.spotify.com`) and the list of Chromium-family browsers, Chrome first.
- `drm.service.ts`: `needsDrm(url)`, `handOff(url)` (opens `chrome --app=URL` in a separate window), `findBrowser()`.
- `drm-launch.ts`: command line and profile. Own profile `~/.local/share/webswitch/drm-profile`. Flags: `--app`, `--no-first-run`, `--no-default-browser-check`, `--disable-blink-features=WebAuth` (passkeys off, so Google falls back to passwords), `--test-type` (hides Chrome's "unsupported flag" bar, which otherwise pushes the page down). Before launch (only if Chrome is not running for that profile) `Preferences` gets notifications blocked for all sites so Chrome never asks "Allow notifications?"; permissions belong in Webswitch (to-do).
- Routing (`routeDrm` in `bootstrap.ts`): a DRM URL typed in the address bar, clicked as a link, opened by `window.open`, or reached by a redirect takes over **the tab that navigated** (or a new tab when there was none). It is recorded in history with the title Chrome gives the window.
- **Embedded mode (default on):** `WEBSWITCH_EMBED_DRM=0` disables it. Wayland cannot embed another program's window, so the whole browser runs on **X11 through XWayland** (`GDK_BACKEND=x11`, set before GTK opens its display) and the Chrome window is reparented into a container over the tab. Requirements checked by `embeddingRequested()`: a `DISPLAY`, `python3`, a Chromium-family browser.
  - `embed.service.ts` starts `helpers/x11-embed.py` (Xlib through ctypes; GJS cannot call Xlib) and talks to it by lines on stdin/stdout: `init`, `adopt pid|class <v> [ms]`, `place`, `show`, `hide`, `focus`, `close`, `alive`, `title`, `shot`.
  - Chrome's process for the profile is found through the profile's `SingletonLock` symlink; the helper adopts that process's first managed window.
  - **Adoption must follow ICCCM 4.1.4**: withdraw the window, wait until mutter has let go (parent is the root again), then reparent and map. Reparenting a mapped, managed window makes mutter frame it again. (My first "verification" only read pixels and did not check the parent — always check the window tree.)
  - The window is visible for a moment before it moves in: it starts 64×64 and is adopted with 10 ms polling (measured ~6 ms). Mutter clamps off-screen positions and ignores `--start-minimized`, so it cannot be hidden entirely.
  - A tick callback on the tab's blank web view sends `place`/`show`/`hide` (position, size, tab showing, ⋮ menu covering). Once a second `alive` and `title` are polled; a dead window closes the tab; the title updates the tab and the history.
  - Known limits: the browser is on XWayland (softer fractional scaling); while Chrome has keyboard focus Webswitch's shortcuts do not fire; the window is hidden while the ⋮ menu is open; **not yet verified by hand: typing/login inside the embedded window, audio/video with Widevine, menu hide/show, multi-tab switching.**
- The self-test pins `WEBSWITCH_EMBED_DRM=0` and puts `tests/fake-bin/google-chrome-stable` first in `PATH`, so it checks the app-window path and the launch flags without opening Chrome.

## 9. Testing, measuring, diagnosing

- **`npm run selftest`** (`src/main/selftest.ts`, `scripts/selftest.sh`): builds, serves `tests/site` on 127.0.0.1:8765, uses private XDG dirs, opens a real window and drives it through the same IPC the UI uses plus real GDK key events. Checks tabs, navigation, popups + `opener`, shortcuts (incl. real key events), Keybindings edits and conflicts, the menu, History, DevTools, zoom, failed loads, closing, the DRM hand-off flags/prefs/history. Screenshots go to `$WEBSWITCH_SELFTEST_OUT`. **Known flake:** the ⋮ popover check ("the menu popover opens" / "the menu button shows it is open") fails now and then under synthetic input on Wayland (passes roughly 2 of 3 runs). It is not caused by the DRM work; real clicks are untested by the suite.
- **`npm run measure`** (`tools/measure-net.sh`): runs the browser in an empty network namespace (`unshare -Urn`, dummy interface at the resolver address, `tools/dns-sink.py` answering NXDOMAIN and logging names, `strace -f` on connect/send). Idle 60 s and the whole self-test both produced **0 non-local connections and 0 DNS questions**; a control run (pages at `rig-control.invalid`) showed the rig sees attempts. Re-run after WebKitGTK updates. It sets `WEBSWITCH_APP_ID=dev.webswitch.Measure` and the sandbox-off variable (measurement only).
- **`node tools/bench/bench.mjs [--browsers webswitch,firefox,chrome] [--out f.json]`**: startup, memory (PSS from `/proc/PID/smaps_rollup`, over the browser's session), process count, idle CPU, 5 heavy tabs, JS/DOM suite. Results on 2026-09-24 (WebKitGTK 2.52.6, Firefox 155, Chrome 153): startup 0.42 s (Chrome 0.43, Firefox 1.10); 1 tab 218–292 MB (Chrome 242, Firefox 664); 5 tabs 584–660 MB (Chrome 509, Firefox 973); idle CPU 0.2 % (Chrome 0.3); JS suite 691 ms (Chrome 674, Firefox 702). See `docs/performance.md` for caveats. Compare browsers within one run, not across machines.

### Crash hunting recipes (learned the hard way)

- Core dumps: `ulimit -c unlimited`, then `coredumpctl list` / `coredumpctl info <pid>` (stack traces; `eu-stack` exists, `gdb` does not). A process killed by SIGKILL leaves **no** core dump.
- **Who sent a SIGKILL?** `strace -f` shows `kill(pid, SIGKILL)` calls from the traced tree. **`strace -k` hangs GJS** ("gjs is not responding": the main thread sits in `ptrace_stop`); do not use it, and `strace -p` cannot attach (yama `ptrace_scope=1`). Use an `LD_PRELOAD` shim that wraps `kill()` and prints `backtrace_symbols_fd` when `sig == SIGKILL` (gcc exists; the UI process loads it, sandboxed children cannot see `/tmp`). Resolve `libwebkitgtk` offsets with `DEBUGINFOD_URLS=https://debuginfod.opensuse.org eu-addr2line -f -C -e /lib64/libwebkitgtk-6.0.so.4 <offset>`.
- The WebKit enum name lookup (`WebKit.LoadEvent[event]`, `WebKit.WebProcessTerminationReason[reason]`) returns `undefined` in GJS; spell the names out (`tabs.service.ts` does).
- `WEBKIT_DEBUG=IPC` prints "Unknown logging channel"; that channel does not exist in this build.
- X11 windows: `xprop -root _NET_CLIENT_LIST`, `xprop -id <xid> WM_STATE _NET_WM_PID`. A window in state `Iconic` is minimized (it can be started minimized; check before assuming it is visible). Inspect the tree with `XQueryTree` (ctypes) to see who the parent is.
- `journalctl --user` only shows the user journal (no system entries).
- Run test instances with private data: `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `WEBSWITCH_APP_ID`.

## 10. GJS and GTK gotchas

- ES modules: `gjs -m dist/main.js`; `gi://Gtk?version=4.0` imports stay external in the Vite bundle. `import.meta.url` gives the dist dir; `System.programArgs` gives the command line.
- **GJS has no** `URL`, `URLSearchParams`, `queueMicrotask`, `structuredClone`. Use `GLib.Uri` (`core/url.ts`) and `Promise.resolve().then(...)`.
- `Gio._promisify(...)` is required for each `*_async` function you `await` (see `files.ts`, `webkit-async.ts`, `embed.service.ts`).
- **Never pass a bare `Uint8Array` to `write_all_async`.** The garbage collector can free it before the write starts and the file gets heap garbage (the first 16 bytes of each history line were corrupted this way; reproduced 299/299 lines). Use `write_bytes_async(new GLib.Bytes(...))`. Lines already written by the old code may be unreadable in a user's `history.jsonl`.
- **WebKit cookies:** `WebsiteDataManager.fetch(COOKIES)` names cookies by registrable domain ("example.org"), and `CookieManager.get_cookies("https://example.org/")` does **not** return a cookie that belongs only to a subdomain ("moodle.example.org"), which is how many login cookies are set. `cookies.service.ts` therefore reads WebKit's own database with `Soup.CookieJarDB.new(path, true).all_cookies()` (no SQLite binary needed; there is none) and overlays the live query. The database has **no creation date column** (only expiry and lastAccessed), so "first seen" is tracked by Webswitch. `add_cookie` rejects a `__Secure-` cookie that is not marked Secure. WebKit has no per-site cookie rules, hence the stash-and-restore design.
- `evaluate_javascript` does not await promises; poll from the caller (see `selftest.ts`).
- `WebView` has no `new_with_related_view`; use the `related_view` property. A `create` handler that refuses a window returns `null` (typed as `NO_WINDOW`).
- The app exits if nothing holds it while the async setup runs: `app.hold()` / `release()` in `bootstrap.ts`. `command-line` (`HANDLES_COMMAND_LINE`) opens URLs given on the command line in the running browser.
- A `Gtk.Popover` around a web view needs a `ScrolledWindow` holder with fixed sizing; `Gtk.Stack.remove` requires the child to still be a child of the stack (guarded in `closeTab`).
- **One WebView must never be two tabs.** `ready-to-show` can fire twice; the handler is idempotent (`shown` flag). Duplicated registration produced `gtk_widget_set_parent` warnings, "WebView has been already disposed" and a SIGSEGV in `gtk_accessible_update_state`.
- Single-instance app: launching with an id already in use forwards to the running instance and exits. If a supposed "restart" shows no new log lines, the old instance is still alive. Killing the PID of `strace` does not kill the traced gjs; check with `ps`.
- Wayland: a popover sometimes does not map under synthetic input; real clicks are not covered by tests. Once, a freshly started instance showed up minimized (`WM_STATE` Iconic) and the user saw no window; the cause was not found, so check the window state before assuming a launched window is visible.

## 11. Decision history (why things are the way they are)

1. Started as an **Electron** browser (Vite + Forge, hybrid architecture, zero requests measured). **Google rejected sign-in** ("This browser or app may not be secure") because Electron is treated as an embedded browser; the only community fix is Chrome impersonation, which the user refused.
2. A **Firefox prototype** (policies + `userChrome.css`) had Google login and zero measured requests, but it was not "Webswitch" (full Firefox, no real code of its own; release Firefox needs signed extensions; Gecko has no desktop embedding).
3. Research for a non-compile alternative led to **WebKitGTK**: the user tested that Google login works in a minimal WebKitGTK browser. Decision: remove Electron and the prototypes and **build on WebKitGTK**, carrying over all styles and features. Migration to GJS/TypeScript is done; a safety archive of the Electron version (`webswitch-electron-final.zip`) is git-ignored.
4. Trade-offs accepted with WebKitGTK: Linux only; **no WebAuthn**; **no DRM** (§8); Web Inspector instead of Chrome DevTools; no WebExtensions yet (upstream is porting them to GTK/WPE; ideas: Bitwarden through `bw serve`, Chii/chobitsu for DevTools, see `to-do.md`).
5. DRM: options weighed and dropped: recompiling WebKitGTK with EME (needs a Widevine host for the GTK port and a license), CEF (no H.264/AAC in prebuilt Linux builds, unreliable Widevine, needs a C++ helper, dmabuf issues on NVIDIA hybrid), Qt WebEngine (not embeddable in GTK 4), Firefox as the DRM engine (no Widevine installed here, no clean app mode, heavier). Chosen: real Chrome, embedded through X11 reparenting (default), with the separate app window as fallback.

## 12. Known issues and open investigations

- **The Moodle of the user's university crashes the web process** (`https://portal.example.edu/...` → `acessa-moodle` → the Moodle host): the page loads for a moment, then the tab shows "Can't load — The page crashed (the web process crashed)". Findings so far: reproduced 5 times (always with `WEBSWITCH_DEBUG=1`), with and without the WebKit sandbox, with and without an opener (so `window.opener` is **not** the cause); not memory (64 GB, no cgroup limit), no OOM kill, no core dump; the **UI process itself sends SIGKILL** to the web process from `WebProcessProxy::didReceiveInvalidMessage` → `AuxiliaryProcessProxy::terminate()` (WebKitGTK 2.52.6): the web process sent an invalid IPC message and WebKit kills it. The message name is still unknown. In the last run without `WEBSWITCH_DEBUG` there was no kill (it is not known whether the user reached the Moodle page in that run), so the debug hooks may contribute. Next steps: rerun the flow in normal mode on a fresh build with the kill-trace shim; find the message name; if it is a WebKitGTK bug, report upstream or work around.
- The self-test popover flake (§9).
- Embedded Chrome tabs: typing, media, Widevine playback, menu hide/show and multi-tab switching are unverified by hand (§8).
- History lines written before the `write_bytes_async` fix may be corrupted and are skipped when loading.
- Placeholders: menu items Switch and Check updates do nothing; no find-in-page, downloads UI, context-menu styling, bookmarks, per-site permission UI, search-engine setting. See `to-do.md`.

## 13. Docs to keep in sync

`README.md` (user guide), `docs/architecture.md`, `docs/privacy.md` (measured zero-request results and method), `docs/performance.md` (measured numbers, PSS), `to-do.md` (priorities), this file. When behavior changes, update the doc that describes it in the same change, and never state a measurement you did not make.
