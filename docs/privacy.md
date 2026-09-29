# Privacy

## The promise

**Webswitch makes no network requests of its own.** It only reaches the network when you navigate: type an address, press Enter, click a link. Nothing happens in the background.

That means the browser has:

- no telemetry or usage statistics,
- no account or sync service,
- no auto-update check,
- no crash reporter,
- no search suggestions,
- no spellcheck dictionary downloads (spellcheck is off),
- no favicon database, Safe Browsing or component updater lookups of its own.

## What counts as a request "of the browser"

These are the requests the promise is about, and they must not happen:

- anything the browser does while idle, at startup or on shutdown;
- update, version or "phone home" checks;
- fetching resources for its own interface (the UI is bundled and served from `webswitch://`, under a Content Security Policy that forbids network access);
- anything triggered by opening or closing tabs, without navigation.

## What does not count

- **Pages you visit.** Loading a page, and everything that page then loads (scripts, images, fonts, trackers, analytics), is your navigation and the site's behavior. Webswitch does not filter content in 0.0.1.
- **Requests initiated by websites**, such as `fetch`, WebSockets, beacons or service workers, while you have their tab open.
- **Local-only traffic**: IPC between the browser's own processes, reading `user.css`, and the local pages of the self-test.

## Dev settings: two requests, only when you press a button

**Dev settings → Check for updates** asks `registry.npmjs.org` which releases of the Chrome DevTools package (Chii) exist; **Install / Update / Switch** downloads the tarball it names and verifies its sha512 checksum from the registry before unpacking it. Nothing else on that page reaches the network, nothing is checked by itself, and there is no timer. These are requests the user asks for, like Chrome for streaming sites, so they are outside the "zero requests of its own" measurement (the self-test only makes them with `WEBSWITCH_SELFTEST_DOWNLOAD=1`). Chrome DevTools itself makes none: it talks to the page through a message bridge inside the browser and opens no port.

## Test in other browsers: requests only when you press a button

**Check for updates** reads the release lists of Chrome for Testing (`googlechromelabs.github.io`), Firefox (`product-details.mozilla.org`), Opera (`ftp.opera.com`) and Edge (`packages.microsoft.com`); **Install** downloads one release from the vendor (`storage.googleapis.com`, `download-installer.cdn.mozilla.net`, `ftp.opera.com`, `packages.microsoft.com`) and checks its SHA-256 against what the vendor publishes when it publishes one. Nothing else on that page reaches the network and nothing runs by itself. The installed browsers, once a tab starts one, do what any browser does (update checks, Widevine, their own services); that is outside the promise, like the Chrome used for streaming pages. Each starts with a throwaway profile that is deleted when its tab closes.

## Themes from VS Code: requests only when you press a button

The **VS Code themes** panel of the Themes page talks to **open-vsx.org**: **Search** asks it for color themes, **Install** downloads one extension (a `.vsix` of a few hundred kilobytes) and checks its SHA-256 against the one Open VSX publishes, **Install the 25 most popular** does that for many. Opening the panel asks for nothing. Nothing is checked or downloaded by itself, and the downloaded file is unpacked in a temporary folder and deleted; only the colors are kept, with the author and the license the extension declares.

## Measured, not just promised

`tools/measure-net.sh` runs the browser from a clean profile inside an **empty network namespace**: its only interfaces are a loopback and a dummy one holding the address `/etc/resolv.conf` points at, where a DNS server answers NXDOMAIN to everything and logs each name asked. `strace` records every `connect()` and `send*()`. So every attempt is visible and none can leave the machine.

Results on 2026-09-24, WebKitGTK 2.52.6:

| Scenario                                                                                                            | Connections to non-local addresses | DNS questions                                           |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------- |
| Blank tab, 60 seconds idle, first run                                                                               | **0**                              | **0**                                                   |
| The whole self-test (tabs, pages, popup, shortcuts, menu, History, Keybindings, Web Inspector, zoom, a failed load) | **0**                              | **0**                                                   |
| Control: the same self-test with its pages at `rig-control.invalid`                                                 | 8                                  | 4 (`rig-control.invalid`, twice with the search domain) |

The control matters: it shows the instrument does see a browser reaching for a name, so the zeros above are not the instrument being blind. These numbers describe one machine and one engine version: run `npm run measure` again after the system updates WebKitGTK.

WebKit applies its own site-specific compatibility adjustments to some sites (this is standard in every WebKit browser and involves no request). Webswitch adds none and leaves the user agent alone.

## Enforced how

- The browser's own code makes no requests, and its UI cannot: `connect-src 'none'`, and no script bridge on pages.
- Spellcheck and DNS prefetching are disabled.
- Every permission request is denied by default ([permissions.service.ts](../src/main/features/permissions/permissions.service.ts)).
- There is no updater, crash reporter or background service.

## Signing in with Google

The sign-in page is an ordinary page you opened, so it counts as your navigation. After you sign in, Google's sites know who you are, as they would in any browser; that is between you and Google. The green dot on the menu's user icon is computed from the local cookie jar and involves no request. Webswitch has no account of its own and syncs nothing.

## History

The browsing history is a local file (`history.jsonl` under `~/.local/share/webswitch/`). It is never uploaded, synced or read by anything but the browser itself. You can remove single entries or clear it from the History page, or delete the file.

## Extensions: off by default, and then your call

**Extensions are off.** Until you turn them on in General settings (or on the Extensions page, after reading a warning and ticking that you understand), no extension can be installed, none runs, and Webswitch does nothing about them. The promise above holds as written.

If you turn them on, you choose to be trackable by what you install:

- **An extension can read and change every page it is allowed to run on** (what you see, what you type, the accounts you are signed in to there), keep it, and send it anywhere. Webswitch cannot see or stop what an extension does with that. Each extension's page lists which sites it may reach before you add it; an ad blocker that only uses Manifest V3 blocking rules never sees your pages.
- **Installing from the Chrome Web Store asks Google.** Pressing Get it sends one request to `clients2.google.com` (the update service every Chromium-based browser uses) with the extension's id, and Google learns that id and your address. Nothing is asked until you press it; there is no update check, so **Update** is also a button. This is one of the requests you ask for, like the ones of Dev settings, and is outside the zero-request measurement. Google's terms for that service are written for Chrome and Chromium, so using it from another browser is a grey area; the alternative would be to not offer store installs at all.
- **What Webswitch checks:** the file's id must match the developer key inside it; it does not verify the signature over the contents. Extensions run in a separate script world in the page, and their own pages and background have a separate storage area. An extension can only make requests from its own pages to the sites its manifest names (the browser makes them), but what a content script or a page it opens does is up to it.
- **What an extension may ask for is listed before you add it, in plain words, in red for the ones that matter most:** `cookies` (every cookie of the sites it may reach), `history`, `webRequest`/`webRequestBlocking` (it sees every request and its headers, and can block or send elsewhere the pages you open), `proxy` (it can send **all** your browsing through a server it chooses), `nativeMessaging` (it can talk to programs on this computer that named it), `userScripts` (it runs its own scripts, or ones you add, inside the pages it reaches), and a site's HTTP login (a password manager may fill it). Anything an extension asks for later (optional permissions) opens a window asking you first.
- **A proxy an extension sets is never silent.** While one is on, a red notice on the Extensions page names the extension, and a red "Proxy" label sits in the toolbar the whole time — with a **Stop using this proxy** button that puts your normal connection back at once.
- **Blocking or redirecting only applies to the pages and frames you open**, not to what a page then loads on its own (scripts, images, XHR): WebKitGTK gives no hook for that, so an extension cannot silently rewrite a page's own requests, only decide whether the page itself loads and where it goes.
- **Extension requests carry WebKit's own User-Agent**, like any page (some servers answer differently to a request without one); nothing imitates another browser.
- **Turning the switch off** stops every extension at once, including any proxy it set, and keeps them installed.

The self-test with `WEBSWITCH_SELFTEST_EXTENSIONS=1` uses only local fixtures; `=store` downloads one real extension and is opt-in. The zero-request measurement (`npm run measure`) was not run again after extensions were added; with the switch off nothing of them runs.
