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

## Extensions

Webswitch 0.0.1 has no extension support. If extensions are added later (see [to-do.md](../to-do.md)): **extensions can make network requests on their own, and that is the responsibility of each extension**, not of the browser. Install only extensions you trust.
