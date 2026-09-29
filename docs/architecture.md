# Architecture

Webswitch is a GJS program (GNOME's JavaScript runtime) that draws a GTK 4 window and uses WebKitGTK's web views for both the pages you visit and the browser's own interface. Everything is TypeScript.

```
src/
├── @types/            # ALL types, interfaces and .d.ts declarations
├── shared/            # runtime constants shared by the native side, the preload and the UI: IPC
│                      # channels, the shortcut catalog, menu items, accelerator format. No gi:// imports
├── main/              # the native side, run by GJS
│   ├── main.ts        # entry point (thin)
│   ├── selftest.ts    # drives the real browser and saves screenshots (npm run selftest)
│   ├── core/          # bootstrap, window, popup window, web views, IPC router, UI scheme, files, config
│   └── features/
│       ├── tabs/          # tabs.service.ts, tabs.ipc.ts
│       ├── account/       # account.service.ts (Google sign-in state), account.ipc.ts
│       ├── history/       # history.service.ts (history.jsonl), history.ipc.ts
│       ├── keybindings/   # keybindings.service.ts (keybindings.json), keybindings.ipc.ts
│       ├── menu/          # menu.service.ts, menu.ipc.ts (the ⋮ side panel)
│       ├── navigation/    # navigation.service.ts, navigation.ipc.ts, url-resolver.ts
│       ├── permissions/   # permissions.service.ts
│       ├── shortcuts/     # shortcuts.service.ts
│       └── user-css/      # user-css.service.ts, user-css.ipc.ts, user.example.css
├── preload/           # builds window.browserApi in the UI's page, on top of WebKit's message handler
└── renderer/          # the browser UI: HTML, CSS and TypeScript, no framework
    ├── index.html
    ├── core/          # UI bootstrap, API client, user.css injection
    ├── features/      # tab-bar, address-bar, menu, history, keybindings, viewport
    └── styles/        # tokens.css, reset.css, base.css
```

Conventions:

- Files are kebab-case. In `main`, each feature is `<feature>.service.ts` (logic) plus `<feature>.ipc.ts` (handlers that only call the service). `permissions` and `shortcuts` have no UI-facing IPC, so they have no `.ipc.ts`.
- **The native side is the single source of truth.** Tab state lives in `TabsService`. The UI only displays it and sends commands. The native side notifies the UI with events when state changes.
- The IPC contract (channels, payloads, return values) is typed in [src/@types/ipc.ts](../src/@types/ipc.ts). Channel names are an `as const` object in [src/shared/ipc-channels.ts](../src/shared/ipc-channels.ts).
- Nothing in `renderer/` or `preload/` imports from `main/`, and vice versa; only `@types` and `shared` are shared. Only `main/` may import `gi://` libraries. ESLint enforces this with `no-restricted-imports`.

## The types rule

`type`, `interface` and ambient declarations (`declare global`, `declare module`) exist **only** inside `src/@types/`. `enum` is forbidden everywhere: use an `as const` object in code and derive the type inside `src/@types/`. ESLint enforces it with `no-restricted-syntax` on `src/**`, with an override for `src/@types/**` that allows everything except enums. The path alias is `~types/*` → `src/@types/*` (in `tsconfig.json` and Vite). Never name an alias `@types`: it collides with the npm `@types/*` packages. `~shared/*` → `src/shared/*` works the same way.

## Build and run

`npm run build` runs three Vite builds into `dist/`: the UI (`dist/renderer/`), the preload script (`dist/preload.js`, one self-contained file) and the native side (`dist/main.js`, an ES module for GJS in which `gi://` imports stay imports). `npm start` builds and then runs `gjs -m dist/main.js`. There is no bundled runtime: GJS, GTK and WebKitGTK come from the system.

## Windows and views

There is no title bar. The main window is a `Gtk.Overlay`:

- the **UI web view** fills the whole window (tab strip, toolbar, and a page area);
- a `Gtk.Stack` with **one web view per tab** sits on top of it, starting below the browser chrome. The UI measures its own chrome height with a `ResizeObserver` and reports it, so restyling with `user.css` never breaks the layout;
- a `Gtk.WindowHandle` over the empty part of the tab strip drags the window, and `Gtk.WindowControls` draws the system's window buttons over the strip's end. The UI reports where the empty part starts (`setTitleBarLayout`) and the native side tells the UI how wide the buttons are (`--window-controls-width`).

A blank tab, a tab that failed to load, and a tab that shows a built-in page hide the page area so the UI's own page area (with the wordmark, the error message or the page) shows through.

**The UI is served, not loaded from disk.** The UI web view loads `webswitch://ui/index.html` through a custom URI scheme handled by `core/ui-scheme.ts`, which serves `dist/renderer/`. A real origin makes its module scripts load and its Content Security Policy meaningful. Tabs are barred from loading `webswitch:` URLs.

**Built-in pages.** A tab can show a page the browser draws itself (`TabState.page`: `keybindings`, `history`, `cookies` and `settings`). Its web view stays hidden and the UI's page area renders the page, so there is no extra web content to secure. The address bar shows it as `webswitch://keybindings`.

**The ⋮ menu is a side panel.** It takes the right half of the window, below the tab strip and the toolbar, while the page takes the left half; closing it gives the page the whole width back. The panel is a small web view (the same bundled UI, loaded with `?view=menu`) added to the window's `Gtk.Overlay`. The overlay's `get-child-position` signal places the page area and the panel from the overlay's own size, so the split follows window resizes. This UI's page area (blank tab, History, Cookies) makes room with a CSS margin while the panel is open, and an embedded Chrome window follows the page area. The panel view shares the main UI's web process and script bridge. A bar along the panel's left edge resizes it (the width is a share of the window, kept between 240 px for the panel and for the page); the share is saved in `ui-state.json` when the drag ends and restored at startup, and every change is sent to the UI so its page area follows.

## IPC

WebKit's script message handlers carry it. A handler named `ipc`, registered with a reply, exists **only on the browser's own views** (the UI and the menu), and answers each call with a JSON string. The preload script (`src/preload`) injected into those views at document start builds `window.browserApi` from it. Tab views never get a handler, so a page can never call the browser. Events go the other way: `IpcRouter.emit` calls `window.__wsEmit(channel, payload)` in each UI view.

## Popups and Google sign-in

Links and `window.open(url)` become tabs. `window.open(url, name, features)` (with a size, the shape of every OAuth popup) is a real popup: a small window with no title bar and a close button, whose web view stays linked to the page that opened it through `window.opener`, so a sign-in can hand its result back. WebKit reports 100×100 when the page asked for no size, which is how a plain link is told from a popup. Only `http:`, `https:` and `about:blank` may open. Popups get no script bridge.

Google's sign-in page loads in a tab like any other. `AccountService` never talks to Google: it watches the session's cookie jar for Google session cookies and tells the menu whether one exists. The user agent is left alone.

## History

`TabsService` reports each finished main-frame load of a web page (after a short pause, because WebKit sets the title a moment later) through a dependency callback; `HistoryService` records it. Entries live in memory, oldest first, and on disk as JSON Lines (`history.jsonl`): visits are appended, and removing or clearing rewrites the file. All disk access is asynchronous (Gio) and chained so writes never reorder. A visit to the same URL within 10 seconds of the previous one is not recorded again.

## General settings

`src/shared/settings-catalog.ts` is the catalog (id, section, kind: toggle/choice/text, default, label, description, and `effect`: `now`, `reload` or `restart`); the value types are derived from it in `src/@types/settings.ts`. `SettingsService` is the only place that validates and stores them (`~/.config/webswitch/settings.json`, only values that differ from the defaults). It is built at the very start of `runBrowser` and reads the file synchronously, because the GPU and X11 choices are needed before GTK opens the display. Anything that needs a value depends on the small `SettingsReader` (`get(id)`), which folds in the old `WEBSWITCH_*` environment overrides. Live changes: `settings.onChanged` in `bootstrap.ts` re-applies the tab preferences to every open view (`core/preferences.ts`: smooth scrolling, page cache, autoplay, WebGL, Web Inspector) and to the network session (tracking prevention, third-party cookies); new views get them when they are created, plus the ones that cannot change afterwards (`hardware_acceleration_policy`). The search engine and the download folder are read when used. A setting whose effect is `restart` is listed in `SettingsState.restartPending` while its value differs from the one this run started with; the page then offers **Restart now**, which calls `restartBrowser` (`core/restart.ts`): a shell waits until this process is gone (the app is single-instance, a new one started earlier would only hand its addresses to this one), then starts `gjs -m .../main.js <open pages>` again with the environment the browser was originally started with (not the one `runBrowser` changed), and this process quits.

## Extensions

Off unless the `extensions` setting is on. `ExtensionsService` installs (Web Store download → CRX3 header check → unzip → summary → user confirms) and keeps them under `~/.local/share/webswitch/extensions/<id>/`. `ExtensionRuntime` puts each extension's content scripts and styles into every tab view (WebKit user scripts in a script world of their own, with a `chrome.*` shim), hosts the background page in a hidden view, opens popups as a `Gtk.Popover` and options pages in a window, serves the files at `webswitch-ext://<id>/`, and converts Manifest V3 blocking rules into WebKit content blockers. Calls from an extension go through one script message handler per extension. Details and limits: the extensions bullet in [CLAUDE.md](../CLAUDE.md); privacy: [privacy.md](privacy.md).

## Keybindings

`src/shared/shortcut-actions.ts` is the catalog of actions and their default accelerators. `KeybindingsService` merges it with the user's overrides from `keybindings.json` and is the only place that validates changes (format, Ctrl/Alt/F-key rule, conflicts). `ShortcutsService` installs a `Gtk.EventControllerKey` on the window in the capture phase, so it sees every key before the focused web view, turns it into the canonical text (`src/shared/accelerator.ts`, e.g. `Ctrl+Shift+T`) and looks the action up. While the Keybindings page records a new combination, shortcuts are suspended.

## Anatomy of an action: clicking "+" (new tab)

1. **UI.** `tab-bar.ts` handles the click and calls `api.tabs.create()`.
2. **Preload.** The bridge posts `{ channel: 'tabs:create', args: [] }` to the `ipc` message handler.
3. **IPC.** `IpcRouter` looks the channel up and calls the handler registered in `tabs.ipc.ts`.
4. **Service.** The handler only calls `TabsService.createTab()`, which creates a hardened web view, adds it to the stack, activates it and, being a blank tab, asks the UI to focus the address bar.
5. **Event back.** The service schedules one coalesced notification; its listener calls `router.emit('tabs:state-changed', state)`.
6. **UI again.** `__wsEmit` reaches the preload's listeners and `renderer/core/main.ts` asks every view to `render(state)`.

Keyboard shortcuts skip steps 1-3.

## Security model

- Tabs are plain web views with no script bridge, no access to `webswitch:` URLs, WebKit's sandbox (bubblewrap) and no file access from pages.
- The UI has a restrictive Content Security Policy (see `renderer/index.html`) and cannot navigate or open windows; its context menu is off. One deliberate relaxation: `style-src` includes `'unsafe-inline'`, because `user.css` is injected in a `<style>` element. `script-src` stays `'self'` and `connect-src` is `'none'`.
- Every permission request (camera, microphone, location, notifications, ...) is denied by default; `PermissionsService` is ready to receive user-granted permissions.
- Spellcheck is off (its dictionaries would be downloaded), and DNS prefetching is off.
- Only `http:` and `https:` pages may be opened by a page.

## Notes on GJS

GJS has no `URL`, `URLSearchParams`, `queueMicrotask` or `structuredClone`, so `core/url.ts` parses URLs with `GLib.Uri`. Async Gio and WebKit functions are turned into promises with `Gio._promisify` (`core/files.ts`, `core/webkit-async.ts`). The GTK/WebKit typings (`@girs/*`) declare many nullable results as non-null, so the `no-unnecessary-condition` lint rule is off in `src/main`.

## Tests

`npm run selftest` opens a real window and drives the browser through the same IPC the UI uses (and real GDK key events), checking tabs, navigation, popups, shortcuts, the menu, History, Keybindings, the inspector, zoom and errors (`WEBSWITCH_SELFTEST_EXTENSIONS=1` runs the extensions scenario with local fixtures), and saving screenshots of the UI and of the composed window. `npm run measure` runs the browser in an empty network namespace and reports every network attempt (see [privacy.md](privacy.md)).

## Embedded Chrome tabs

By default (`WEBSWITCH_EMBED_DRM=0` turns it off) a mode is on in which a DRM page (see `drm-sites.ts`) is shown by a real Chrome window inside a tab. Wayland has no way to embed another program's window, so the browser is started with `GDK_BACKEND=x11` (XWayland) and the embedding is done with plain X11 reparenting:

1. `EmbedService` (`features/drm/embed.service.ts`) starts `helpers/x11-embed.py` (copied to `dist/`). GJS cannot call Xlib, so the helper does: it creates a container window inside the browser's X11 window.
2. Chrome is started in app mode on X11 with the profile in `~/.local/share/webswitch/drm-profile`. Chrome's process for that profile is named by the profile's `SingletonLock`; the helper adopts that process's first managed window.
3. Adoption follows ICCCM 4.1.4: the window is withdrawn, the helper waits until the window manager (mutter) has let go of it (its parent is the root again), then reparents it into the container and maps it. Reparenting a mapped, managed window does not work: the window manager frames it again.
4. The tab is an ordinary blank web view; its allocation is the rectangle. A tick callback follows it (position, size, and whether the tab is showing) and sends `place`, `show` and `hide` to the helper. A once-a-second `alive` check closes the tab when the Chrome window goes away.

`TabsService` keeps `Tab.embed` for such a tab. The tab's title and address come from the URL, not from the page.
