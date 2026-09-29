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
| F12 / Ctrl+Shift+I           | Open developer tools       |
| Ctrl+= / Ctrl+- / Ctrl+0     | Zoom in / out / reset      |

These are the defaults. Every one of them (except Ctrl+1 to Ctrl+8) can be changed from the Keybindings page: open the ⋮ menu at the right end of the toolbar and pick the keyboard icon. Click a shortcut, press the new keys, done. Changes are saved to `keybindings.json`. A shortcut needs Ctrl or Alt (or F1–F12), so it can never steal normal typing.

The address bar takes a URL (`https://example.com`, `example.com`, `localhost:3000`) or a search query. The default search engine is DuckDuckGo; you can change it in General settings.

## The home page

A blank tab shows the wordmark `.webswitch/?q=`, written like the address of a search, with a **text field where its cursor blinks** (after the `=`): type there and press Enter to search, or to go to an address (`example.com`, `localhost:3000`), the same rules as the address bar. Start typing with nothing focused and it goes into the field. Esc clears it. Under the wordmark, at its left, a **list of search engines** (DuckDuckGo, Brave Search, Startpage, Ecosia, Google, Bing) picks the one used, the same choice as in General settings. The search itself is the only request, and only when you press Enter.

## The ⋮ menu

The ⋮ button at the right end of the toolbar opens the menu as a **panel that takes half of the window**: the panel is on the right (under the tab strip and the toolbar) and the page you are on shrinks to the left half, Chrome-embedded pages included. Closing it (the ⋮ again, the × in the panel, Esc, or choosing an item) gives the page its whole width back; clicking the page does not close it. **Drag the bar along the panel's left edge to resize it** (double-click the bar to put it back at half). The panel and the page each keep at least 240 px. The width you choose is remembered when you close and open the menu and between runs (`ui-state.json`). The items, each with its icon and name: switch, cookies and accounts (the user icon), check for updates, history and keybindings. **Keybindings**, **History** and **Cookies and accounts** work; **Switch** and **Check for updates** are placeholders for features on the [to-do list](to-do.md).

The menu (its title is **Switches**) has two groups, with a border between them: **Check for updates** alone at the top (a placeholder that does nothing yet), then **Cookies and accounts** (with a line under it: who is signed in and how many cookies there are), **General settings**, **Themes**, **Extensions**, **Keybindings**, **History** and **Dev settings**.

## General settings

**⋮ menu → General settings** (a tab, `webswitch://settings`). Each setting is a switch, a choice or a text field; there is a search box and **Reset all**. A change that works at once, works at once. One that only works after a restart says "Needs a restart" and raises a banner with **Restart now**: the browser closes and starts again, and the pages that are open are opened again. Your choices are saved in `~/.config/webswitch/settings.json` (only what differs from the defaults; you can edit it by hand).

| Section     | Setting                                  | Default        | Takes effect |
| ----------- | ---------------------------------------- | -------------- | ------------ |
| Performance | Draw pages with the GPU                  | off (software) | restart      |
| Performance | Keep the browser on the integrated GPU   | off            | restart      |
| Performance | Smooth scrolling                         | on             | at once      |
| Performance | Keep pages for fast Back and Forward     | on             | at once      |
| Performance | Play Netflix, Spotify ... inside the tab | on             | restart      |
| Privacy     | Intelligent Tracking Prevention          | off            | at once      |
| Privacy     | Third-party cookies                      | block          | at once      |
| Privacy     | Block autoplaying media                  | off            | next load    |
| Pages       | WebGL                                    | on             | next load    |
| Search      | Search engine                            | DuckDuckGo     | at once      |
| Downloads   | Download folder                          | your Downloads | at once      |

The old environment variables still win over a saved choice (`WEBSWITCH_HW_ACCEL=1`, `WEBSWITCH_GPU=integrated`, `WEBSWITCH_EMBED_DRM=0`); the page says so on that row. **Parallel (segmented) downloads are not offered**: WebKitGTK downloads each file over one connection and has no setting for more.

## Test in other browsers

At the bottom of the ⋮ menu, under a line, a row of icons: **Chrome, Firefox, Opera, Edge, Safari (WebKit)** and a **gear**. Click an icon to open **the page you are on inside a tab**, in that browser: the tab shows the real browser (its own toolbar, its own DevTools), named in the tab ("Firefox 156 · Page Two"). Each one starts with a clean profile that is deleted when the tab closes. The Safari icon opens the page in a new Webswitch tab: WebKit is the engine Webswitch itself runs, the same family as Safari's, not identical (Safari only exists on Apple systems). An icon drawn dim means that browser is not installed yet; clicking it takes you to where it is.

The **gear** opens the page where the browsers are managed. Nothing is bundled: you install what you want, from the vendor:

| Browser           | What you get                                                       | Releases      | Checked against                           |
| ----------------- | ------------------------------------------------------------------ | ------------- | ----------------------------------------- |
| **Chrome**        | Chrome for Testing (Google's build for testing, includes Widevine) | any since 113 | HTTPS only (Google publishes no checksum) |
| **Firefox**       | Mozilla's release, ESR included                                    | any since 115 | Mozilla's SHA-256                         |
| **WebKit**        | Webswitch's own engine                                             | (built in)    | (nothing to install)                      |
| **Opera** (extra) | Opera's package; Chromium underneath                               | any since 100 | Opera's SHA-256                           |
| **Edge** (extra)  | Microsoft Edge; Chromium underneath, about 830 MB                  | any since 100 | Microsoft's SHA-256 when it lists one     |

For each browser the page shows every release installed and **what it takes on disk** (with the total), lets you **install the newest or pick a release from the list**, **update** when **Check for updates** finds a newer one, **choose which release is in use** (you can keep several), and **uninstall** a release to free the space. Files live under `~/.local/share/webswitch/browsers/<browser>/<release>`. Checking and downloading are the only requests the page makes, and only when you press them; the browsers themselves, once running, make their own requests (outside the zero-request promise, like the Chrome for streaming). Internet Explorer cannot run on Linux and was retired in 2022, so it is not offered.

Showing another browser inside a tab needs Webswitch to run on X11 (XWayland): the page tells you when a restart is needed for that. It is the "Show other browsers inside the tab" switch in General settings.

**Netflix and Spotify** can use these too: the page has a section "Netflix, Spotify and similar sites" to choose between the Chrome found on the system, **Chrome (installed here)** and **Edge (installed here)**. Widevine was checked by asking each browser for the key system (`requestMediaKeySystemAccess`), not by playing a title: Chrome for Testing, Edge and Firefox (with DRM switched on in its profile) answered yes, Opera's package answered no, so Opera is not offered. Firefox is not offered for streaming because its window carries the toolbar.

## Themes

**⋮ menu → Themes** changes the colors of the browser (tab strip, address bar, menus, built-in pages, the window buttons and popup frames; not the web pages). Each theme is shown as a small picture. **Automatic** (the default) is Webswitch Dark or Light, whichever your desktop uses; there are also Dracula, Nord, Gruvbox Dark, Monokai, Solarized Dark and Light and High Contrast.

**Add theme** takes a theme from a `.json` file (a file chooser) or from text you paste. Only `name` and the colors `bg`, `fg` and `accent` are needed; the rest are worked out from them:

```json
{
  "name": "My theme",
  "author": "me",
  "scheme": "dark",
  "colors": { "bg": "#101418", "fg": "#e6e6e6", "accent": "#ff8800" }
}
```

**VS Code themes:** the **VS Code themes** button searches **Open VSX**, the open registry of VS Code extensions, for color themes (thousands: Dracula, One Dark Pro, Catppuccin, Tokyo Night, and so on) and installs the ones you pick as Webswitch themes, each keeping its **author and license** on its card. **Install the 25 most popular** adds the most downloaded ones at once. Open VSX is used instead of vscodethemes.com because that site lists Microsoft's Marketplace, which Microsoft only lets its own products use; the themes are the same. An extension may hold several themes (its variants): all are added. A VS Code theme colors an editor, so only what makes sense for a browser is taken from it (the background, the text, a main color that stands out, the status colors); the rest is worked out. Searching and installing are the only requests this makes, and only when you press the buttons; each download is checked against the checksum Open VSX publishes.

The other colors you may set: `raised`, `hover`, `border`, `fgStrong`, `fgSoft`, `fgMuted`, `info`, `success`, `danger`. Colors are `#rgb` or `#rrggbb` and nothing else is accepted, so a theme file cannot add CSS. Themes you add are kept in `~/.config/webswitch/themes/` (drop a file there by hand and it is found at the next start), the choice in `~/.config/webswitch/theme.json`. Your own `user.css` still wins over the theme. A theme you added has a **Remove** button; the ones that ship with Webswitch stay.

## Extensions

**Off by default.** Webswitch does not track you and nobody else does either; extensions change that if you want them to. Open **⋮ menu → Extensions**: until you allow them the page only explains the risk (an extension can read and change the pages it runs on, keep it and send it anywhere; installing from the Chrome Web Store tells Google which extension you asked for) and offers **Allow extensions** after you tick that you understand. The same switch is in **General settings → Privacy**. Turning it off stops every extension at once and keeps them installed.

Once allowed you can **paste a Chrome Web Store address or the 32-letter id** and press **Get it**, or **load a folder** (an unpacked extension, for developers). Before anything is kept you see what the extension may do: every site or only some, which of its permissions work in Webswitch, which will not, and which do nothing. Installed extensions can be turned off, updated (install the same one again), opened in their **Options**, or removed. An extension with a button shows it between the address bar and the ⋮ button (a popup opens under it).

What works: content scripts and styles (also ones an extension registers while running), popups, options pages, background scripts, ports and messages between the parts of an extension, storage, tabs, windows, cookies (including watching them change), history (including watching visits), downloads (started, followed and listed for real), notifications, the page's right-click menu, extension shortcuts, an offscreen document, `chrome.identity` sign-in windows (a plain window on your own session, so an existing Google/GitHub login is reused), **user scripts** (`chrome.userScripts`, for Tampermonkey/Violentmonkey-style extensions, in a world of their own), a **proxy an extension sets** (`chrome.proxy`: applied to every page, with a visible red notice on the Extensions page and a chip in the toolbar the whole time it is on, and a one-click **Stop using this proxy**), **blocking or sending elsewhere the pages and frames you open** (`webRequest.onBeforeRequest` and declarativeNetRequest redirect rules — this covers page navigations, not the scripts, images or XHRs a page then makes: WebKitGTK has no hook for those), **native messaging** with programs you installed (Bitwarden Desktop, KeePassXC...: the program's JSON file must name the extension), and blocking rules of Manifest V3 extensions (converted to WebKit's content blocker: uBlock Origin Lite's 124,000 rules compile in about five seconds). Every permission that matters is explained in plain words, in red, before you add the extension — proxy, cookies, history, request blocking, native messaging and the like all say what they let the extension do. Tested on real Store extensions: Bitwarden (login included, up to the server), Dark Reader, Vimium, Privacy Badger, uBlock Origin Lite, Ghostery. What does not: `chrome.debugger`, tab/desktop/page capture, ports between two different extensions, a real multi-window `chrome.windows`, and anything that needs the Chrome browser itself. Content scripts run on pages loaded after the extension was turned on. The pages of an extension announce WebKit (not Chrome) as their browser, so a few extensions take their Safari paths.

The sites' own HTTP logins (the ones that ask for a username and password) now have a window, also without extensions — an extension with the right permission may also answer it (a password manager).

## Developer tools and Dev settings

**F12** (or Ctrl+Shift+I) opens **Chrome DevTools** docked under the page, with a line in the theme's main color on its top edge; drag that line to resize (double-click resets it), and the size is remembered. It is the real Chrome DevTools frontend (the Chii build), so Elements, Console, Network and Application work; the page-side is a script that runs in the page, which means **no debugger with breakpoints**, and a page whose Content-Security-Policy forbids `eval` cannot run Console commands. It reloads when the page navigates. It belongs to the tab you opened it on: another tab does not show it, and switching back finds it as you left it. On the home page and built-in pages it closes when you leave that tab. No port is opened: the frontend and the page talk through a message bridge inside the browser.

**⋮ menu → Dev settings** chooses which developer tools F12 opens:

- **Chrome DevTools**, the default. A release comes with Webswitch, so it works without any download. From here you can **update** it, **install any other release** (every one the npm registry has, older ones included) or **uninstall** it. Uninstalling deletes the copy you downloaded and sets the bundled one aside (its files stay in the app folder); installing the bundled release again puts it back without downloading anything. The DevTools of Opera and Edge are this same frontend.
- **Safari Web Inspector (WebKit)**: the engine's own inspector, the same code Safari uses. Full debugger, timelines, storage. Built in.

On the home page, a load error and the built-in pages (Dev settings, History ...) F12 inspects the browser's own UI with the same developer tools you chose.

**Check for updates** asks the npm registry which releases exist; **Install/Update/Switch** downloads one and verifies its checksum. Those two buttons are the only requests this page makes, and only when pressed. There are no Firefox DevTools: they run inside Firefox and speak Gecko's own protocol, so they cannot inspect a WebKit page.

## Cookies and accounts

The user icon in the ⋮ menu opens the Cookies page: every cookie in the browser, grouped by company (Google, Microsoft, and any other site under its own name).

- **What it shows:** for each cookie its name, site, what it does behind the scenes (in plain words), when Webswitch first saw it, when it expires, its flags (Secure, HttpOnly, SameSite) and what kind it is (sign-in, security, preferences, analytics). The filter starts on **Sign-in**; **All** shows everything and **Restricted** shows only the ones you disabled or limited.
- **Search** by cookie name, site, company or what it does.
- **Account panel:** companies Webswitch knows have a button that opens their account page in a tab (for example **Google account panel**, **Microsoft account panel**; also Meta, Apple, Amazon, GitHub, LinkedIn, X, Spotify, Netflix, Dropbox, Reddit and Adobe). A Google button stays at the top of the page, so you can sign in even before there is a Google cookie.
- **Disable / Enable:** a disabled cookie is no longer sent to any site, but Webswitch keeps it, so **Enable** brings the login back.
- **One rule per company:** inside each group, a bar sets a rule for **all** of that company's cookies at once: **Allowed everywhere**, **Disabled**, or **Only on…** the sites you list (for example, every Google cookie only on `google.com` and `youtube.com`). The rule also covers the cookies the company sets later, so it does not need redoing. A cookie you set by hand (Enable, Disable or Only on… on that cookie) keeps its own choice and is not overruled by the company rule; the badge on each cookie says when its state comes from the company rule.
- **Only on…** (per cookie): allow a cookie only while a tab is on the sites you list (for example `youtube.com`). It is taken out of the browser when no tab is on those sites and put back before the request when you type one of those addresses, click a link or send a form to it.
- **Remove:** deletes the cookie for good, after a confirmation that says what stops working (for a Google sign-in cookie: you are signed out of Google and "Sign in with Google" stops working on other sites until you sign in again). Each company also has **Remove all**, which deletes the cookies currently shown for it.

The page never shows cookie values. Webswitch keeps a copy of the disabled and restricted cookies (values included) in `~/.local/share/webswitch/cookie-policies.json`, readable only by you, next to the browser's own cookie database, which already holds the same values in plain text.

Limits worth knowing: WebKit does not store creation dates, so "first seen" starts counting when Webswitch first runs with this feature (older cookies say "before tracking"). A redirect the site makes by itself, or a script that changes the address, can reach a restricted site before its cookie is back; reload once. The explanations come from a built-in list of well-known cookies and name patterns; for a cookie it does not know, it says so. Cookies of the Chrome used for DRM pages (Netflix, Spotify) live in that Chrome's own profile and are not managed here.

## If the screen flickers

Webswitch draws tab contents in software (no GPU compositing). With GPU compositing, fast wheel scrolling made fixed headers (YouTube, Laracasts) jump and text flicker on a 144 Hz laptop; a bare WebView in a plain GTK window did the same, so it comes from WebKitGTK, not from Webswitch, and software drawing stopped it. The cost is more CPU on animated pages and slower WebGL. `WEBSWITCH_HW_ACCEL=1 npm start` goes back to WebKit's own choice.

A 60 Hz screen setting, the integrated GPU (`WEBSWITCH_GPU=integrated npm start`), and the DMABUF, compositing and GSK renderer switches did not help. `tools/flicker/` has the measuring tools and two minimal browsers for comparing.

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

- The whole browser runs in XWayland: fractional scaling looks softer, and on some GPU setups rendering can flicker (reported while scrolling). `WEBSWITCH_EMBED_DRM=0 npm start` goes back to native Wayland, at the cost of Netflix and Spotify opening in a separate Chrome window.
- While the embedded window has keyboard focus, Webswitch's own shortcuts (Ctrl+T, Ctrl+W ...) do not fire. Click the tab strip or address bar to get them back.
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

| What                           | Where                                  |
| ------------------------------ | -------------------------------------- |
| `user.css`, `keybindings.json` | `~/.config/webswitch/`                 |
| History, cookies, site data    | `~/.local/share/webswitch/`            |
| Installed extensions           | `~/.local/share/webswitch/extensions/` |
| Cache                          | `~/.cache/webswitch/`                  |

If you used the earlier Electron version, your `user.css`, `keybindings.json` and history are copied from `~/.config/Webswitch/` on the first run (nothing is overwritten and the old folder is left alone).

## Developer tools

F12 opens the developer tools chosen in Dev settings (Chrome DevTools by default; see above). The shortcut lives on the **Keybindings** page as "Open developer tools": change it there, or remove it to turn F12 off. Right click → Inspect Element always works. Neither Chrome DevTools nor the WebKit inspector has a Lighthouse panel, and browser extensions cannot add panels. See [to-do.md](to-do.md).

## Project layout

See [docs/architecture.md](docs/architecture.md). Rules worth knowing before you contribute: all `type`, `interface` and ambient declarations live in `src/@types/`, and `enum` is forbidden. ESLint enforces both.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
