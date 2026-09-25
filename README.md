# Webswitch

A minimal, private, CSS-stylable web browser for developers, built on WebKitGTK (the engine of GNOME Web) and written in TypeScript.

Version 0.0.1 · Linux only for now · [GPL-3.0](LICENSE)

## Philosophy

- **Zero requests of its own.** The browser never connects to anything by itself: no telemetry, sync, auto-update, crash reports, search suggestions or dictionary downloads. It touches the network only when you navigate. It is measured, not just promised: see [docs/privacy.md](docs/privacy.md).
- **Minimal and practical.** A tab strip, an address bar, the WebKit Web Inspector and keyboard shortcuts. Nothing else.
- **Styled by you.** The whole interface is restyled with a single `user.css` file.
- **Honest about resources.** It is a full web engine, so memory use is in the same range as other browsers. See [docs/performance.md](docs/performance.md) for measured numbers.

## Running on openSUSE Tumbleweed

You need Node.js (only to build), GJS (GNOME's JavaScript runtime), GTK 4 and WebKitGTK 6. Most desktops already have the last three:

```sh
sudo zypper install nodejs-default npm-default gjs typelib-1_0-Gtk-4_0 typelib-1_0-WebKit-6_0 libwebkitgtk-6_0-4 bubblewrap xdg-dbus-proxy
npm install
npm start
```

`bubblewrap` and `xdg-dbus-proxy` are what WebKit uses to sandbox its web processes.

To add Webswitch to your applications menu (per user, no root):

```sh
npm run build
./scripts/install.sh
```

Other scripts: `npm run lint`, `npm run typecheck`, `npm run format`, `npm run make` (builds `out/webswitch-<version>-linux.tar.gz`), `npm run selftest` (opens a real window and drives the browser, saving screenshots), `npm run measure` (see [docs/privacy.md](docs/privacy.md)).

Give it an address or a search on the command line, and it opens as a tab (in the running browser, if there is one):

```sh
webswitch example.com "how does a hash map work"
```

## Keyboard shortcuts

| Shortcut                     | Action                     |
| ---------------------------- | -------------------------- |
| Ctrl+T                       | New tab                    |
| Ctrl+Shift+T                 | Reopen the last closed tab |
| Ctrl+W                       | Close tab                  |
| Ctrl+Tab / Ctrl+PageDown     | Next tab                   |
| Ctrl+Shift+Tab / Ctrl+PageUp | Previous tab               |
| Ctrl+1 … Ctrl+8 / Ctrl+9     | Jump to tab 1–8 / last tab |
| Ctrl+L / Alt+D / F6          | Focus the address bar      |
| Ctrl+R / F5                  | Reload                     |
| Ctrl+Shift+R / Ctrl+F5       | Reload, ignoring the cache |
| Alt+← / Alt+→                | Back / forward             |
| Ctrl+H                       | Open History               |
| F12 / Ctrl+Shift+I           | Toggle the Web Inspector   |
| Ctrl+= / Ctrl+- / Ctrl+0     | Zoom in / out / reset      |

These are the defaults. Every one of them (except Ctrl+1 to Ctrl+8) can be changed from the Keybindings page: open the ⋮ menu at the right end of the toolbar and pick the keyboard icon. Click a shortcut, press the new keys, done. Changes are saved to `keybindings.json`. A shortcut needs Ctrl or Alt (or F1–F12), so it can never steal normal typing.

The address bar takes a URL (`https://example.com`, `example.com`, `localhost:3000`) or a search query. The default search engine is DuckDuckGo; it is defined in one place, [src/main/core/config.ts](src/main/core/config.ts).

## The ⋮ menu

An icon-only menu at the right end of the toolbar: switch, sign in with Google, check for updates, history and keybindings. **Keybindings**, **History** and **Sign in with Google** work; **Switch** and **Check for updates** are placeholders for features on the [to-do list](to-do.md).

## Signing in with Google

It works: the sign-in page loads in a tab, the "Sign in with Google" popups of other sites can hand their result back to the page that opened them, and the session survives restarts. There is no Webswitch account and nothing is synced; the sign-in is Google's own page, opened because you clicked.

This is confirmed with a minimal browser on the same engine and settings; if Google ever refuses it on your machine, please report it. Webswitch does not change its user agent or pretend to be another browser. WebKit does apply its own site-specific compatibility adjustments, as it does in every WebKit browser.

Not supported by the engine: WebAuthn, so security keys and passkeys will not work (passwords, authenticator-app codes and phone prompts do).

## DRM video and music (Netflix, Spotify, Disney+ ...)

WebKitGTK has no DRM (its Encrypted Media Extensions are not compiled in, and Widevine has no GTK port), so these sites cannot play inside a Webswitch tab. Instead, Webswitch opens them in an app window (no tabs, no address bar) of an installed Chromium-family browser: Google Chrome first, then Edge, Brave, Vivaldi or Chromium. It uses its own profile in `~/.local/share/webswitch/drm-profile/`, so your normal Chrome profile is untouched; you sign in to Netflix or Spotify once there.

The list of sites is in [src/main/features/drm/drm-sites.ts](src/main/features/drm/drm-sites.ts). Without a Chromium-family browser installed, those pages just load in the tab and will not play. Chrome is a separate program: its own network behavior is not covered by Webswitch's zero-request promise.

### Netflix and Spotify inside a tab

Wayland cannot embed another program's window, so this mode runs Webswitch on X11 (through XWayland) and puts the Chrome app window _inside_ the tab. It is on by default when Webswitch can do it (an X display, `python3`, and Chrome or another Chromium-family browser). To keep native Wayland and use the separate app window instead, start with `WEBSWITCH_EMBED_DRM=0`.

Open a DRM site (for example netflix.com). The tab shows the site's Chrome window, sized to the tab area, and follows resizes and tab switches. Closing the tab closes the window, and closing the window inside Chrome closes the tab. How it works: [docs/architecture.md](docs/architecture.md#embedded-chrome-tabs).

The Chrome used for these pages is set up so it does not ask things that belong in Webswitch: passkeys (WebAuthn) are switched off, so Google's sign-in falls back to a password, and notifications are blocked for every site, so it never asks "Allow notifications?". A DRM page opens in the tab where you typed or clicked the link, and it is recorded in the history like any other page (with the title Chrome gives it). Per-site permissions are on the [to-do list](to-do.md).

The Chrome window is visible for a few milliseconds before it is moved into the tab; it starts as a tiny window to keep that unnoticeable.

Known limits of this mode:

- The whole browser runs in XWayland: fractional scaling looks softer.
- While the embedded window has keyboard focus, Webswitch's own shortcuts (Ctrl+T, Ctrl+W ...) do not fire. Click the tab strip or address bar to get them back.
- The ⋮ menu is drawn behind an X11 child window, so the window is hidden while the menu is open.
- Needs `python3` (a small helper talks Xlib) and Google Chrome (or another Chromium-family browser).
- Not yet verified by hand: typing and video playback inside the embedded window, Widevine playback, and the hide/show around the menu.

Plain video and audio work in tabs (YouTube, most sites): H.264, AAC, VP9, AV1 and Opus decode through GStreamer.

## History

Open it from the ⋮ menu (clock icon) or with Ctrl+H. Visits are grouped by day; search by title or address, click one to open it in the same tab, hover to remove it, or clear everything (it asks for a second click). Only `http` and `https` pages are recorded, and failed loads are not. History is stored in `history.jsonl` under `~/.local/share/webswitch/` and never leaves your machine.

## Styling with user.css

On first run Webswitch creates `user.css` in its config directory, full of commented-out examples:

```
~/.config/webswitch/user.css
```

It is loaded after every built-in style, so anything in it wins, and it reloads as soon as you save it. Every color, size and font of the interface is a CSS custom property defined in [src/renderer/styles/tokens.css](src/renderer/styles/tokens.css):

```css
:root {
  --color-accent: #63afc5;
  --radius: 4px;
  --tab-height: 60px;
  --font-ui: 'Iosevka', monospace;
}

@media (prefers-color-scheme: light) {
  :root {
    --color-bg: #ffffff;
  }
}
```

You can also target any element directly (`.tab`, `#address-bar`, `.address-input`, ...). To find selectors, start the browser with `WEBSWITCH_DEBUG=1`, which enables right click → Inspect Element on the interface itself. Light and dark themes follow your desktop.

The window buttons (close, and minimize/maximize if your desktop shows them) are drawn by GTK over the end of the tab strip; their colors are set from the palette, not from `user.css`.

## Where things are kept

| What                           | Where                       |
| ------------------------------ | --------------------------- |
| `user.css`, `keybindings.json` | `~/.config/webswitch/`      |
| History, cookies, site data    | `~/.local/share/webswitch/` |
| Cache                          | `~/.cache/webswitch/`       |

If you used the earlier Electron version, your `user.css`, `keybindings.json` and history are copied from `~/.config/Webswitch/` on the first run (nothing is overwritten and the old folder is left alone).

## Developer tools

F12 opens the WebKit Web Inspector (the same one as Safari's), docked to the page. It is a full inspector (Elements, Console, Sources, Network, Timelines, Storage, Audit) but it is not Chrome DevTools: there is no Lighthouse panel and browser extensions cannot add panels. See [to-do.md](to-do.md).

## Project layout

See [docs/architecture.md](docs/architecture.md). Rules worth knowing before you contribute: all `type`, `interface` and ambient declarations live in `src/@types/`, and `enum` is forbidden. ESLint enforces both.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
