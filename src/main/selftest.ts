import GLib from 'gi://GLib?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Soup from 'gi://Soup?version=3.0';
import WebKit from 'gi://WebKit?version=6.0';
import System from 'system';
import { webStoreDetailId } from '~shared/crx';
import { SETTINGS } from '~shared/settings-catalog';
import { parseTheme } from '~shared/theme-format';
import { convertVsCodeTheme, mergeIncluded, parseJsonc } from '~shared/vscode-theme';
import type { BrowserContext } from '~types/bootstrap';
import type { BrowserId } from '~types/browsers';
import type { CookiesSummary } from '~types/cookies';
import type { TabsState } from '~types/tabs';
import { runBrowser } from './core/bootstrap';
import { searchEngineFor } from './core/config';
import { relaunchCommand } from './core/restart';
import { chromeColors } from './core/theme';
import { resolveInput } from './features/navigation/url-resolver';
import { readText } from './core/files';
import { loadUiState } from './core/ui-state';
import './core/webkit-async';

// Drives the real browser (real GTK window, real WebKit views, the same IPC bridge the UI uses),
// checks what it can and saves screenshots. Run through scripts/selftest.sh, which serves the pages.
const OUT = GLib.getenv('WEBSWITCH_SELFTEST_OUT') ?? '/tmp';
const SITE = GLib.getenv('WEBSWITCH_SELFTEST_SITE') ?? 'http://localhost:8765';
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
}
async function waitFor(condition: () => boolean | Promise<boolean>, ms = 8e3): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (await condition()) return true;
    await sleep(100);
  }
  return false;
}
let evaluations = 0;
/**
 * Runs an expression in a view and returns its JSON-serializable value. WebKit does not wait for
 * promises, so the result is parked on `window` and polled.
 */
async function evaluate(view: WebKit.WebView, expression: string): Promise<unknown> {
  const key = `__selftest${++evaluations}`;
  await view.evaluate_javascript(
    `Promise.resolve(${expression}).then(
       (value) => { window.${key} = JSON.stringify({ value }); },
       (error) => { window.${key} = JSON.stringify({ error: String(error) }); },
     ); 0`,
    -1,
    null,
    null,
    null,
  );
  for (let waited = 0; waited < 8e3; waited += 50) {
    const raw = (
      await view.evaluate_javascript(`window.${key} ?? 'PENDING'`, -1, null, null, null)
    ).to_string();
    if (raw !== 'PENDING') {
      const result = JSON.parse(raw) as { value?: unknown; error?: string };
      if (result.error !== undefined) throw new Error(result.error);
      return result.value ?? null;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${expression}`);
}
async function screenshot(view: WebKit.WebView, name: string): Promise<void> {
  (
    await view.get_snapshot(WebKit.SnapshotRegion.VISIBLE, WebKit.SnapshotOptions.NONE, null)
  ).save_to_png(`${OUT}/${name}.png`);
}
/** The whole window as GTK composes it: the UI, the page area, overlays. */
function windowShot(context: BrowserContext, name: string): void {
  const { overlay, window } = context.main;
  const width = overlay.get_width();
  const height = overlay.get_height();
  const snapshot = new Gtk.Snapshot();
  new Gtk.WidgetPaintable({ widget: overlay }).snapshot(snapshot, width, height);
  const node = snapshot.to_node();
  (node ? window.get_native()?.get_renderer()?.render_texture(node, null) : null)?.save_to_png(
    `${OUT}/${name}.png`,
  );
}
/** Any window as GTK draws it, its own border included. */
function toplevelShot(window: Gtk.Window, name: string): void {
  const snapshot = new Gtk.Snapshot();
  new Gtk.WidgetPaintable({ widget: window }).snapshot(
    snapshot,
    window.get_width(),
    window.get_height(),
  );
  const node = snapshot.to_node();
  (node ? window.get_native()?.get_renderer()?.render_texture(node, null) : null)?.save_to_png(
    `${OUT}/${name}.png`,
  );
}
async function scenario(context: BrowserContext): Promise<void> {
  const { main, ui, tabs, history, shortcuts, menu, menuView, settings, bookmarksPopup } = context;
  const ipc = <T>(expression: string): Promise<T> => evaluate(ui, expression) as Promise<T>;
  const state = () => tabs.getState();
  const activeView = () => {
    const view = tabs.getActiveView();
    if (!view) throw new Error('no active tab');
    return view;
  };
  const engine = `WebKitGTK ${WebKit.get_major_version()}.${WebKit.get_minor_version()}.${WebKit.get_micro_version()}`;
  console.log(`engine: ${engine}`);
  check(
    'UI loaded from webswitch://ui/',
    await waitFor(() => !ui.is_loading && (ui.get_uri() ?? '').startsWith('webswitch://ui/')),
    ui.get_uri() ?? '',
  );
  await sleep(1200);
  check(
    'preload built window.browserApi',
    (await ipc<string>('typeof window.browserApi')) === 'object',
  );
  const blank = await ipc<TabsState>('window.browserApi.tabs.getState()');
  check(
    'IPC round trip: one blank tab',
    blank.tabs.length === 1 && blank.tabs[0]?.url === '',
    JSON.stringify(blank.tabs[0]),
  );
  const accent = await ipc<string>(
    "getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()",
  );
  check('tokens.css applied', accent === '#e8adb9', accent);
  const dark = await ipc<boolean>("matchMedia('(prefers-color-scheme: dark)').matches");
  console.log(`info: UI prefers-color-scheme dark = ${String(dark)}`);
  const chromeHeight = await ipc<number>(
    "document.getElementById('chrome').getBoundingClientRect().height",
  );
  const controls = await ipc<string>(
    "getComputedStyle(document.documentElement).getPropertyValue('--window-controls-width').trim()",
  );
  check('UI told the width of the window buttons', controls.endsWith('px'), controls);
  check(
    'user.css injected',
    (await ipc<number>("document.getElementById('user-css')?.textContent.length ?? 0")) > 0,
  );
  check(
    'blank tab shows the wordmark',
    (await ipc<string>("document.querySelector('.wordmark')?.textContent ?? ''")) ===
      '.webswitch/?q=',
  );
  console.log(
    `info: window ${main.window.get_width()}x${main.window.get_height()}, overlay ${main.overlay.get_width()}x${main.overlay.get_height()}`,
  );
  await screenshot(ui, 'ui-blank');
  windowShot(context, 'window-blank');
  await ipc(`window.browserApi.navigation.navigate('${SITE}/index.html')`);
  check(
    'navigates through the UI',
    await waitFor(() => state().tabs[0]?.title === 'Local Test Page'),
    JSON.stringify(state().tabs[0]),
  );
  check('page area is visible for a web page', main.stack.get_visible());
  const [pageAreaKnown, pageArea] = main.stack.compute_bounds(main.overlay);
  check(
    'page area starts below the chrome',
    pageAreaKnown && Math.abs(pageArea.get_y() - Math.ceil(chromeHeight)) <= 1,
    `chrome ${chromeHeight}px, page area at ${pageAreaKnown ? pageArea.get_y() : 'n/a'}px`,
  );
  await sleep(500);
  check(
    'visit recorded in history',
    history.query('', 10).some((entry) => entry.url === `${SITE}/index.html`),
  );
  // Bookmarks: the bar below the chrome, the star in the address bar, folders.
  const bookmarkUrl = `${SITE}/index.html`;
  const addedBookmark = await ipc<{ id: string; url: string }>(
    `window.browserApi.bookmarks.add(${JSON.stringify(bookmarkUrl)}, 'Local Test Page', null)`,
  );
  check(
    'bookmarks.add creates a bookmark',
    addedBookmark.url === bookmarkUrl,
    JSON.stringify(addedBookmark),
  );
  check(
    'the bookmarks bar shows it',
    await waitFor(
      async () =>
        (await ipc<number>("document.getElementById('bookmarks-bar').children.length")) === 1,
    ),
  );
  check(
    'the bar item shows the title',
    (await ipc<string>(
      "document.querySelector('.bookmark-item .bookmark-item__label')?.textContent ?? ''",
    )) === 'Local Test Page',
  );
  check(
    'the star fills in for a bookmarked page',
    await waitFor(
      async () =>
        await ipc<boolean>(
          "document.querySelector('.bookmark-star')?.classList.contains('is-active') ?? false",
        ),
    ),
  );
  const bookmarkFolder = await ipc<{ id: string; title: string }>(
    "window.browserApi.bookmarks.addFolder('Test folder', null)",
  );
  check('bookmarks.addFolder creates a folder', bookmarkFolder.title === 'Test folder');
  await ipc(
    `window.browserApi.bookmarks.update(${JSON.stringify(addedBookmark.id)}, { folderId: ${JSON.stringify(bookmarkFolder.id)} })`,
  );
  check(
    'moving the bookmark into a folder shows the folder in the bar instead',
    await waitFor(
      async () =>
        (await ipc<string>(
          "document.querySelector('.bookmark-item .bookmark-item__label')?.textContent ?? ''",
        )) === 'Test folder',
    ),
  );
  // A second top-level bookmark, pointing at a real local page (not a fake domain: a plain click
  // on it below is a real navigation, not just an API call), so there is something real to
  // drag-and-drop-reorder against the folder above too.
  const secondBookmark = await ipc<{ id: string; title: string }>(
    `window.browserApi.bookmarks.add(${JSON.stringify(`${SITE}/two.html`)}, 'Second Bookmark', null)`,
  );
  check(
    'the bar shows the folder then the new bookmark, in that order',
    await waitFor(async () => {
      const labels = await ipc<string[]>(
        "[...document.querySelectorAll('.bookmark-item .bookmark-item__label')].map(e => e.textContent)",
      );
      return JSON.stringify(labels) === JSON.stringify(['Test folder', 'Second Bookmark']);
    }),
  );
  // A plain click (press and release with no real movement) must still navigate -- the user's
  // own report was exactly that clicking became unreliable once dragging was added the first
  // time (native HTML5 drag-and-drop, `draggable="true"`, since replaced by the Pointer Events
  // implementation below, which this proves does not have the same problem). `pointerdown` and
  // `pointerup` are dispatched first, to actually exercise the drag-tracking code on a real,
  // no-movement press (not skip it), then a `click` -- real hardware input has the browser
  // synthesize that itself after a pointerdown/up pair, which a manually dispatched pointerup
  // alone does not do, so it is added explicitly here to still prove the click handler itself
  // fires (and is not left suppressed by the drag-tracking code for a press that never dragged).
  await ipc(
    "(() => { const btn = [...document.querySelectorAll('.bookmark-item')].find(e => e.querySelector('.bookmark-item__label').textContent === 'Second Bookmark'); const r = btn.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const fire = (t, Ctor = PointerEvent) => btn.dispatchEvent(new Ctor(t, { bubbles: true, cancelable: true, pointerId: 1, clientX: x, clientY: y, button: 0 })); fire('pointerdown'); fire('pointerup'); fire('click', MouseEvent); })()",
  );
  check(
    'a plain click on a bar bookmark navigates there',
    await waitFor(
      () => state().tabs.find((tab) => tab.id === state().activeTabId)?.title === 'Page Two',
    ),
    JSON.stringify(state().tabs.find((tab) => tab.id === state().activeTabId)),
  );
  await ipc(`window.browserApi.navigation.navigate(${JSON.stringify(bookmarkUrl)})`);
  await waitFor(
    () => state().tabs.find((tab) => tab.id === state().activeTabId)?.title === 'Local Test Page',
  );
  // A real drag (Pointer Events, past the movement threshold, onto another bar item) must
  // reorder the bar, and must *not* also fire a click on either end (no accidental navigation or
  // folder-popup-opening from the same press-and-release that just moved something).
  const urlBeforeDrag = state().tabs.find((tab) => tab.id === state().activeTabId)?.url;
  // The trailing 'click' matters here, not just for realism: real hardware input has the browser
  // fire one after a pointerdown/up pair regardless of movement in between, which is exactly what
  // the drag-tracking code's own suppressClick exists to intercept -- without dispatching it here
  // too, this check would prove nothing about that (there would be no click to suppress either way).
  await ipc(
    "(() => { const items = [...document.querySelectorAll('.bookmark-item')]; const from = items.find(e => e.querySelector('.bookmark-item__label').textContent === 'Test folder'); const to = items.find(e => e.querySelector('.bookmark-item__label').textContent === 'Second Bookmark'); const fr = from.getBoundingClientRect(), tr = to.getBoundingClientRect(); const sx = fr.left + fr.width / 2, sy = fr.top + fr.height / 2, ex = tr.left + tr.width / 2, ey = tr.top + tr.height / 2; const fire = (el, t, x, y, Ctor = PointerEvent) => el.dispatchEvent(new Ctor(t, { bubbles: true, cancelable: true, pointerId: 1, clientX: x, clientY: y, button: 0 })); fire(from, 'pointerdown', sx, sy); fire(from, 'pointermove', sx + 20, sy); fire(from, 'pointermove', ex, ey); fire(from, 'pointerup', ex, ey); fire(from, 'click', ex, ey, MouseEvent); })()",
  );
  check(
    'a real drag (Pointer Events, past the threshold) reorders the bar',
    await waitFor(async () => {
      const labels = await ipc<string[]>(
        "[...document.querySelectorAll('.bookmark-item .bookmark-item__label')].map(e => e.textContent)",
      );
      return JSON.stringify(labels) === JSON.stringify(['Second Bookmark', 'Test folder']);
    }),
  );
  check(
    'and the drag did not also navigate or open a popup as a spurious click',
    state().tabs.find((tab) => tab.id === state().activeTabId)?.url === urlBeforeDrag &&
      !bookmarksPopup.isOpen(),
  );
  // The folder's right-click menu (rename/delete): a real popover again, like the star's. A
  // single check after one short, fixed wait (not a `waitFor` retry loop re-touching the view
  // on every poll) -- a Gtk.Popover can dismiss itself (autohide) with no real pointer/focus to
  // hold it open in this automated run, and re-evaluating in the gap between an isOpen() check
  // and the evaluate() call landing was enough to hit exactly that race in an earlier version of
  // this check (a real, reproduced crash, not a hypothetical).
  await ipc(
    `window.browserApi.bookmarks.openPopup('folder-menu', ${JSON.stringify(bookmarkFolder.id)}, 100, 100, 30, 30)`,
  );
  check('the folder-menu popover opens', await waitFor(() => bookmarksPopup.isOpen()));
  await sleep(500);
  if (bookmarksPopup.isOpen()) {
    const folderMenuView = bookmarksPopup.view();
    if (folderMenuView) {
      const value = await evaluate(
        folderMenuView,
        "document.querySelector('.bm-popup__input')?.value ?? ''",
      );
      check(
        'and shows the folder rename form, pre-filled with its current name',
        value === 'Test folder',
        String(value),
      );
      // "Add bookmark here…" / "Add folder here…": the user's own follow-up request, swapping
      // this same already-open popover's content in place, same as the bar's own add-menu.
      const rows = await evaluate(
        folderMenuView,
        "[...document.querySelectorAll('.bm-popup__row-label')].map(e => e.textContent)",
      );
      check(
        'and offers to add a bookmark or a sub-folder inside it',
        JSON.stringify(rows) === JSON.stringify(['Add bookmark here…', 'Add folder here…']),
        JSON.stringify(rows),
      );
      await evaluate(folderMenuView, "[...document.querySelectorAll('.bm-popup__row')][1].click()");
      if (bookmarksPopup.isOpen()) {
        const header = await evaluate(
          folderMenuView,
          "document.querySelector('.bm-popup__header')?.textContent ?? ''",
        );
        check('switching to the new-folder form', header === 'New folder', String(header));
        await evaluate(
          folderMenuView,
          "document.querySelector('.bm-popup__input').value = 'Sub-folder'",
        );
        await evaluate(
          folderMenuView,
          "document.querySelector('.bm-popup__button--primary').click()",
        );
      }
    }
    if (bookmarksPopup.isOpen()) bookmarksPopup.close();
  } else {
    console.log('info: the folder-menu popover closed itself before its content could be read');
  }
  // The sub-folder just created inside "Test folder" must show up when browsing its contents
  // (left click, `kind: 'folder'`), or it would be created but stay unreachable.
  await ipc(
    `window.browserApi.bookmarks.openPopup('folder', ${JSON.stringify(bookmarkFolder.id)}, 100, 100, 30, 30)`,
  );
  await sleep(500);
  if (bookmarksPopup.isOpen()) {
    const contentsView = bookmarksPopup.view();
    if (contentsView) {
      const rows = await evaluate(
        contentsView,
        "[...document.querySelectorAll('.bm-popup__row-label')].map(e => e.textContent)",
      );
      check(
        'the sub-folder created from the right-click menu shows up inside its parent',
        (rows as string[]).includes('Sub-folder'),
        JSON.stringify(rows),
      );
    }
    bookmarksPopup.close();
  } else {
    console.log('info: the folder-contents popover closed itself before its content could be read');
  }
  await ipc(
    `window.browserApi.bookmarks.renameFolder(${JSON.stringify(bookmarkFolder.id)}, 'Renamed folder')`,
  );
  check(
    "renameFolder (what the popover's Save button calls) renames it in the bar",
    await waitFor(async () => {
      const labels = await ipc<string[]>(
        "[...document.querySelectorAll('.bookmark-item .bookmark-item__label')].map(e => e.textContent)",
      );
      return labels.includes('Renamed folder');
    }),
  );
  // A bar bookmark's own right-click menu edits that specific bookmark, not whatever the active
  // tab happens to be on (the active tab here is still SITE/index.html, a different bookmark
  // entirely, so this also proves the popup is really looking the id up, not falling back).
  await ipc(
    `window.browserApi.bookmarks.openPopup('bookmark', ${JSON.stringify(secondBookmark.id)}, 100, 100, 30, 30)`,
  );
  check('the bookmark right-click popover opens', await waitFor(() => bookmarksPopup.isOpen()));
  await sleep(500);
  if (bookmarksPopup.isOpen()) {
    const bookmarkMenuView = bookmarksPopup.view();
    if (bookmarkMenuView) {
      const header = await evaluate(
        bookmarkMenuView,
        "document.querySelector('.bm-popup__header')?.textContent ?? ''",
      );
      const name = await evaluate(
        bookmarkMenuView,
        "document.querySelector('.bm-popup__input')?.value ?? ''",
      );
      check(
        "and edits that specific bookmark (not the active tab's)",
        header === 'Edit bookmark' && name === 'Second Bookmark',
        JSON.stringify({ header, name }),
      );
    }
    await ipc('window.browserApi.bookmarks.closePopup()');
  } else {
    console.log('info: the bookmark popover closed itself before its content could be read');
  }
  await ipc(`window.browserApi.bookmarks.remove(${JSON.stringify(secondBookmark.id)})`);
  // Right-click on the bar's own empty space (not an item): the "add by hand" menu the user
  // asked for. Dispatched straight on the bar element itself, which is what a right-click on the
  // empty space past the last item would also hit (its own listener checks event.target, not
  // hit-testing, so this is the same path a real one takes once it reaches the container).
  await ipc(
    "document.getElementById('bookmarks-bar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))",
  );
  check('the add-by-hand menu opens', await waitFor(() => bookmarksPopup.isOpen()));
  await sleep(400);
  if (bookmarksPopup.isOpen()) {
    const addMenuView = bookmarksPopup.view();
    if (addMenuView) {
      const rows = await evaluate(
        addMenuView,
        "[...document.querySelectorAll('.bm-popup__row-label')].map(e => e.textContent)",
      );
      check(
        'offering to add a bookmark or a folder by hand',
        JSON.stringify(rows) === JSON.stringify(['New bookmark…', 'New folder…']),
        JSON.stringify(rows),
      );
      // Choosing "New folder…" swaps the same popover's own content in place (no new native
      // round trip), straight to a name field.
      await evaluate(addMenuView, "[...document.querySelectorAll('.bm-popup__row')][1].click()");
      if (bookmarksPopup.isOpen()) {
        const header = await evaluate(
          addMenuView,
          "document.querySelector('.bm-popup__header')?.textContent ?? ''",
        );
        check('and switches to the new-folder form', header === 'New folder', String(header));
        await evaluate(
          addMenuView,
          "document.querySelector('.bm-popup__input').value = 'Hand-made folder'",
        );
        await evaluate(addMenuView, "document.querySelector('.bm-popup__button--primary').click()");
      }
    }
  } else {
    console.log('info: the add-by-hand popover closed itself before its content could be read');
  }
  check(
    'creating a folder by hand from that form adds it to the bar',
    await waitFor(async () => {
      const labels = await ipc<string[]>(
        "[...document.querySelectorAll('.bookmark-item .bookmark-item__label')].map(e => e.textContent)",
      );
      return labels.includes('Hand-made folder');
    }),
  );
  const handMadeFolder = (
    await ipc<{ folders: { id: string; title: string }[] }>('window.browserApi.bookmarks.get()')
  ).folders.find((folder) => folder.title === 'Hand-made folder');
  if (handMadeFolder) await ipc(`window.browserApi.bookmarks.removeFolder('${handMadeFolder.id}')`);
  // The "Only show the bookmarks bar on the home page" setting: we are on SITE/index.html here,
  // not the home page (a blank tab, url === ''), so turning it on should hide the bar even
  // though it still has the folder in it from the check just above.
  await ipc("window.browserApi.settings.set('bookmarksBarHomeOnly', true)");
  check(
    'the bookmarks-bar-on-home-page-only setting hides the bar on a real page',
    await waitFor(
      async () => await ipc<boolean>("document.getElementById('bookmarks-bar').hidden"),
    ),
  );
  await ipc("window.browserApi.settings.set('bookmarksBarHomeOnly', false)");
  check(
    'turning it back off shows the bar again',
    await waitFor(
      async () => !(await ipc<boolean>("document.getElementById('bookmarks-bar').hidden")),
    ),
  );
  await ipc(`window.browserApi.bookmarks.remove(${JSON.stringify(addedBookmark.id)})`);
  await ipc(`window.browserApi.bookmarks.removeFolder(${JSON.stringify(bookmarkFolder.id)})`);
  check(
    'removing everything hides the bar again',
    await waitFor(
      async () => await ipc<boolean>("document.getElementById('bookmarks-bar').hidden"),
    ),
  );
  check(
    'the star empties out again',
    await waitFor(
      async () =>
        !(await ipc<boolean>(
          "document.querySelector('.bookmark-star')?.classList.contains('is-active') ?? true",
        )),
    ),
  );
  // The native Gtk.Popover (bookmarks-popup.ts): a window screenshot does not show it (it is its
  // own surface, the same reason an extension's own popup was never seen in one either), so this
  // reads its actual state and content straight from the widget and its own WebKit view instead.
  await ipc("window.browserApi.bookmarks.openPopup('star', null, 100, 100, 30, 30)");
  check(
    'the star popover opens as a real Gtk.Popover',
    await waitFor(() => bookmarksPopup.isOpen()),
  );
  // A Gtk.Popover can dismiss itself (autohide) with no real pointer/focus to hold it open in
  // this automated run, so every step below re-checks isOpen() before touching the view again
  // rather than assuming it is still there.
  const popoverView = bookmarksPopup.isOpen() ? bookmarksPopup.view() : null;
  check('it has its own WebKit view', popoverView !== null);
  if (popoverView && bookmarksPopup.isOpen()) {
    await sleep(500);
    if (bookmarksPopup.isOpen()) {
      const header = await evaluate(
        popoverView,
        "document.querySelector('.bm-popup__header')?.textContent ?? ''",
      );
      check(
        'and loads the popup UI, showing the star form',
        header === 'Bookmark added' || header === 'Edit bookmark',
        String(header),
      );
      if (bookmarksPopup.isOpen()) {
        // A snapshot of a view hosted in a Gtk.Popover is not always available right away;
        // this is a diagnostic aid, not a functional check, so a failure here is not fatal.
        await screenshot(popoverView, 'bookmarks-star-popup').catch((error: unknown) => {
          console.log(`info: could not screenshot the popover: ${String(error)}`);
        });
      }
    } else {
      console.log('info: the bookmarks popover closed itself before its content could be read');
    }
  }
  if (bookmarksPopup.isOpen()) await ipc('window.browserApi.bookmarks.closePopup()');
  check('the popover ends up closed', await waitFor(() => !bookmarksPopup.isOpen()));
  await screenshot(ui, 'ui-page');
  await screenshot(activeView(), 'tab-page');
  windowShot(context, 'window-page');
  const tabsBefore = state().tabs.length;
  await evaluate(activeView(), "document.getElementById('blank').click()");
  check(
    'target=_blank opens a new tab',
    await waitFor(() => state().tabs.length === tabsBefore + 1),
    `tabs ${state().tabs.length}`,
  );
  check(
    'the new tab loads the page',
    await waitFor(() => state().tabs.at(-1)?.title === 'Page Two'),
    state().tabs.at(-1)?.title ?? '',
  );
  await ipc(`window.browserApi.navigation.navigate('${SITE}/opener.html')`);
  await waitFor(
    () => state().tabs.find((tab) => tab.id === state().activeTabId)?.title === 'Opener',
  );
  const openerView = activeView();
  openerView.get_settings().set_javascript_can_open_windows_automatically(true);
  const windowCount = () => Gtk.Window.list_toplevels().length;
  const windowsBefore = windowCount();
  await evaluate(openerView, 'window.startPopup()');
  check(
    'window.open with a size opens a popup window',
    await waitFor(() => windowCount() === windowsBefore + 1),
    `windows ${windowsBefore} -> ${windowCount()}`,
  );
  await sleep(1500);
  const got = (await evaluate(openerView, 'window.got')) as { token?: string } | null;
  check(
    'the popup can talk back to its opener (OAuth-style)',
    got?.token === 'abc123',
    JSON.stringify(got),
  );
  check('the popup is not a tab', state().tabs.length === tabsBefore + 1);
  for (const popup of Gtk.Window.list_toplevels())
    if (popup instanceof Gtk.Window && popup.get_transient_for() !== null) {
      toplevelShot(popup, 'window-popup');
      popup.close();
    }
  const count = state().tabs.length;
  check('Ctrl+T opens a tab', shortcuts.trigger('Ctrl+T') && state().tabs.length === count + 1);
  const controllers = main.window.observe_controllers();
  const keyControllers: Gtk.EventControllerKey[] = [];
  for (let i = 0; i < controllers.get_n_items(); i++) {
    const controller = controllers.get_item(i);
    if (
      controller instanceof Gtk.EventControllerKey &&
      controller.get_propagation_phase() === Gtk.PropagationPhase.CAPTURE
    )
      keyControllers.push(controller);
  }
  const press = (keyval: number, modifiers: Gdk.ModifierType): void => {
    for (const controller of keyControllers)
      GObject.signal_emit_by_name(controller, 'key-pressed', keyval, 0, modifiers);
  };
  await sleep(400);
  const beforeKey = state().tabs.length;
  press(Gdk.KEY_t, Gdk.ModifierType.CONTROL_MASK);
  check('a real Ctrl+T key event opens a tab', state().tabs.length === beforeKey + 1);
  press(Gdk.KEY_w, Gdk.ModifierType.CONTROL_MASK);
  check('a real Ctrl+W key event closes it', state().tabs.length === beforeKey);

  // Pin, mute and reorder (added 2026-09-29 on request). Pinning groups a tab at the front of the
  // strip and gives it a narrow, icon-only tile; muting flips WebKit's own `view.is_muted`, not a
  // separate flag kept here; reordering drags a tab to a new position, with the native side always
  // keeping the pinned group first regardless of what the drag sends (CLAUDE.md §5: the native side
  // stays the single source of truth for that rule, not just a convention the renderer keeps).
  const pinA = tabs.createTab(`${SITE}/index.html`);
  const pinB = tabs.createTab(`${SITE}/two.html`);
  await waitFor(() => state().activeTabId === pinB);
  const freshPinB = state().tabs.find((tab) => tab.id === pinB);
  check(
    'a new tab starts unpinned and unmuted',
    freshPinB !== undefined && !freshPinB.pinned && !freshPinB.muted,
  );
  await ipc(`window.browserApi.tabs.setPinned(${String(pinB)}, true)`);
  check(
    'pinning moves the tab to the front of the strip',
    await waitFor(() => state().tabs[0]?.id === pinB && state().tabs[0]?.pinned === true),
    JSON.stringify(state().tabs.map((tab) => [tab.id, tab.pinned])),
  );
  await ipc(`window.browserApi.tabs.setPinned(${String(pinA)}, true)`);
  check(
    'pinning a second tab keeps both grouped at the front, in pin order',
    state().tabs[0]?.id === pinB && state().tabs[1]?.id === pinA,
    JSON.stringify(state().tabs.map((tab) => tab.id)),
  );
  await ipc(`window.browserApi.tabs.setPinned(${String(pinB)}, false)`);
  check(
    'unpinning moves it to just after the remaining pinned tabs, not back to its old spot',
    state().tabs[0]?.id === pinA && state().tabs[1]?.id === pinB,
    JSON.stringify(state().tabs.map((tab) => tab.id)),
  );
  await ipc(`window.browserApi.tabs.setMuted(${String(pinB)}, true)`);
  check(
    'muting a tab is reported back through the state',
    await waitFor(() => state().tabs.find((tab) => tab.id === pinB)?.muted === true),
  );
  await ipc(`window.browserApi.tabs.setMuted(${String(pinB)}, false)`);
  check(
    'unmuting clears it',
    await waitFor(() => state().tabs.find((tab) => tab.id === pinB)?.muted === false),
  );
  await ipc(`window.browserApi.tabs.setPinned(${String(pinA)}, false)`);
  const reversed = [...state().tabs.map((tab) => tab.id)].reverse();
  await ipc(`window.browserApi.tabs.reorder(${JSON.stringify(reversed)})`);
  check(
    'reorder(order) applies a full new order',
    await waitFor(
      () => JSON.stringify(state().tabs.map((tab) => tab.id)) === JSON.stringify(reversed),
    ),
    JSON.stringify(state().tabs.map((tab) => tab.id)),
  );
  await ipc(`window.browserApi.tabs.setPinned(${String(pinB)}, true)`);
  const wrongOrder = state()
    .tabs.map((tab) => tab.id)
    .filter((id) => id !== pinB)
    .concat(pinB);
  await ipc(`window.browserApi.tabs.reorder(${JSON.stringify(wrongOrder)})`);
  check(
    'a reorder cannot pull a pinned tab out of the pinned group even if the order sent asks for that',
    await waitFor(() => state().tabs[0]?.id === pinB),
    JSON.stringify(state().tabs.map((tab) => [tab.id, tab.pinned])),
  );
  await ipc(`window.browserApi.tabs.setPinned(${String(pinB)}, false)`);
  // A real click on the pin button (not just the IPC call above) must toggle it and must *not*
  // also activate the tab -- the button's own click handler stops propagation before the tab
  // root's click-to-activate handler ever sees the event.
  const activeBeforePinClick = state().activeTabId;
  await ipc(
    `(() => { const btn = document.querySelector('.tab[data-tab-id="${String(pinA)}"] .tab__pin'); const r = btn.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const fire = (t, Ctor = PointerEvent) => btn.dispatchEvent(new Ctor(t, { bubbles: true, cancelable: true, pointerId: 1, clientX: x, clientY: y, button: 0 })); fire('pointerdown'); fire('pointerup'); fire('click', MouseEvent); })()`,
  );
  check(
    'a real click on the pin button pins the tab and does not also activate it',
    (await waitFor(() => state().tabs.find((tab) => tab.id === pinA)?.pinned === true)) &&
      state().activeTabId === activeBeforePinClick,
    JSON.stringify(state().tabs.map((tab) => [tab.id, tab.pinned])),
  );
  await ipc(`window.browserApi.tabs.setPinned(${String(pinA)}, false)`);
  // A real drag (Pointer Events, past the movement threshold) between two ordinary tabs, with a
  // trailing click the way real hardware input fires one after a pointerdown/up pair regardless of
  // movement -- the same check the bookmarks bar's own drag test makes, and for the same reason:
  // this is exactly what an earlier version of that drag code got wrong (the suppressor was a
  // second listener added too late to run before the click handler already registered; see
  // CLAUDE.md's `bookmarks` entry), so it is worth proving independently here too, not just by
  // structural similarity to that already-fixed code.
  const activeBeforeDrag = state().activeTabId;
  await ipc(
    `(() => { const from = document.querySelector('.tab[data-tab-id="${String(pinA)}"]'); const to = document.querySelector('.tab[data-tab-id="${String(pinB)}"]'); const fr = from.getBoundingClientRect(), tr = to.getBoundingClientRect(); const sx = fr.left + fr.width / 2, sy = fr.top + fr.height / 2, ex = tr.left + tr.width / 2, ey = tr.top + tr.height / 2; const fire = (el, t, x, y, Ctor = PointerEvent) => el.dispatchEvent(new Ctor(t, { bubbles: true, cancelable: true, pointerId: 1, clientX: x, clientY: y, button: 0 })); fire(from, 'pointerdown', sx, sy); fire(from, 'pointermove', sx + 20, sy); fire(from, 'pointermove', ex, ey); fire(from, 'pointerup', ex, ey); fire(from, 'click', ex, ey, MouseEvent); })()`,
  );
  check(
    'a real drag on the strip reorders it, and the trailing click activates nothing new',
    (await waitFor(() => state().tabs[0]?.id === pinB && state().tabs[1]?.id === pinA)) &&
      state().activeTabId === activeBeforeDrag,
    JSON.stringify(state().tabs.map((tab) => tab.id)),
  );
  tabs.closeTab(pinA);
  tabs.closeTab(pinB);

  press(Gdk.KEY_ISO_Left_Tab, Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.SHIFT_MASK);
  press(Gdk.KEY_Tab, Gdk.ModifierType.CONTROL_MASK);
  check(
    'editing a shortcut through IPC works',
    (await ipc<{ ok: boolean }>("window.browserApi.keybindings.set('newTab', ['Ctrl+Shift+K'])"))
      .ok,
  );
  await sleep(400);
  check('the old shortcut no longer fires', !shortcuts.trigger('Ctrl+T'));
  check('the new shortcut fires', shortcuts.trigger('Ctrl+Shift+K'));
  check(
    'a conflicting shortcut is refused',
    !(await ipc<{ ok: boolean }>("window.browserApi.keybindings.set('closeTab', ['Ctrl+Shift+K'])"))
      .ok,
  );
  await ipc('window.browserApi.keybindings.resetAll()');
  await ipc(`window.browserApi.navigation.navigate('${SITE}/two.html')`);
  await waitFor(
    () => state().tabs.find((tab) => tab.id === state().activeTabId)?.title === 'Page Two',
  );
  await waitFor(() => main.stack.get_visible() && main.stack.get_width() > 0);
  const windowWidth = main.overlay.get_width();
  check(
    'with the menu closed the page has the whole width',
    Math.abs(main.stack.get_width() - windowWidth) <= 1,
    `${main.stack.get_width()} of ${windowWidth}`,
  );
  await ipc('window.browserApi.menu.toggle()');
  check('the menu opens', await waitFor(() => menu.isOpen()));
  await waitFor(() => menuView.get_width() > 0 && main.stack.get_width() < windowWidth);
  check(
    'the menu takes half of the window width',
    Math.abs(menuView.get_width() - windowWidth / 2) <= 1,
    `${menuView.get_width()} of ${windowWidth}`,
  );
  check(
    'and the page takes the other half',
    Math.abs(main.stack.get_width() - windowWidth / 2) <= 1,
    `${main.stack.get_width()} of ${windowWidth}`,
  );
  check(
    'the menu sits under the tab strip and the toolbar, level with the page',
    menuView.get_height() === main.stack.get_height() &&
      menuView.get_height() < main.overlay.get_height(),
    `${menuView.get_height()} of ${main.overlay.get_height()}`,
  );
  const areaMargin = await ipc<number>(
    "Math.round(parseFloat(getComputedStyle(document.getElementById('viewport')).marginRight))",
  );
  const innerWidth = await ipc<number>('window.innerWidth');
  check(
    "the UI's own page area leaves the right half free too",
    Math.abs(areaMargin - innerWidth / 2) <= 2,
    `${areaMargin} of ${innerWidth}`,
  );
  check(
    'the menu button shows it is open',
    (await ipc<string>("document.querySelector('.menu-button').getAttribute('aria-expanded')")) ===
      'true',
  );
  const labels = (await evaluate(
    menuView,
    "[...document.querySelectorAll('.menu-label')].map((label) => label.textContent)",
  )) as string[];
  check(
    'the menu lists 8 items with their names',
    labels.length === 8 && labels.every((label) => label.length > 0),
    labels.join(' | '),
  );
  await screenshot(menuView, 'menu');
  windowShot(context, 'window-menu');
  main.window.set_default_size(1e3, 700);
  await waitFor(() => main.overlay.get_width() !== windowWidth, 3e3);
  const resized = main.overlay.get_width();
  check(
    'the 50/50 split follows the window size',
    resized !== windowWidth &&
      Math.abs(menuView.get_width() - resized / 2) <= 1 &&
      Math.abs(main.stack.get_width() - resized / 2) <= 1,
    `${menuView.get_width()} + ${main.stack.get_width()} of ${resized}`,
  );
  main.window.set_default_size(windowWidth, main.overlay.get_height());
  await waitFor(() => main.overlay.get_width() === windowWidth, 3e3);
  check(
    'the panel starts at half of the window',
    Math.abs(main.getSidePanelFraction() - 0.5) < 0.001,
    String(main.getSidePanelFraction()),
  );
  GObject.signal_emit_by_name(main.splitterDrag, 'drag-begin', 3, 100);
  GObject.signal_emit_by_name(main.splitterDrag, 'drag-update', -200, 0);
  await sleep(300);
  check(
    'dragging the splitter to the left widens the panel',
    Math.abs(menuView.get_width() - (windowWidth / 2 + 200)) <= 2 &&
      Math.abs(main.stack.get_width() - (windowWidth / 2 - 200)) <= 2,
    `${main.stack.get_width()} + ${menuView.get_width()} of ${windowWidth}`,
  );
  const dragMargin = await ipc<number>(
    "Math.round(parseFloat(getComputedStyle(document.getElementById('viewport')).marginRight))",
  );
  check(
    "and the UI's own page area follows it",
    Math.abs(dragMargin - (innerWidth / 2 + 200)) <= 3,
    `${dragMargin} of ${innerWidth}`,
  );
  GObject.signal_emit_by_name(main.splitterDrag, 'drag-end', -200, 0);
  const widened = menuView.get_width();
  const uiStatePath = GLib.build_filenamev([
    GLib.get_user_data_dir(),
    'webswitch',
    'ui-state.json',
  ]);
  check(
    'the size is written to disk when the drag ends',
    await waitFor(async () => ((await loadUiState()).menuFraction ?? 0) > 0.6),
    (await readText(uiStatePath)) ?? 'no file',
  );
  await ipc('window.browserApi.menu.close()');
  await waitFor(() => !menu.isOpen());
  await ipc('window.browserApi.menu.toggle()');
  await waitFor(() => menu.isOpen() && menuView.get_width() > 0);
  await sleep(200);
  check(
    'closing and opening the menu keeps the size',
    Math.abs(menuView.get_width() - widened) <= 1,
    `${menuView.get_width()} vs ${widened}`,
  );
  main.setSidePanelFraction(0.99);
  await sleep(200);
  check(
    'the page always keeps a usable width',
    main.stack.get_width() >= 238 && menuView.get_width() + main.stack.get_width() === windowWidth,
    `${main.stack.get_width()} + ${menuView.get_width()}`,
  );
  main.setSidePanelFraction(0.01);
  await sleep(200);
  check('and so does the panel', menuView.get_width() >= 238, String(menuView.get_width()));
  main.setSidePanelFraction(0.5);
  await sleep(200);
  check(
    'setting it back to half works',
    Math.abs(menuView.get_width() - windowWidth / 2) <= 1,
    String(menuView.get_width()),
  );
  await ipc('window.browserApi.menu.close()');
  check('closing the menu hides the panel', await waitFor(() => !menu.isOpen()));
  await waitFor(() => main.stack.get_width() >= main.overlay.get_width() - 1, 3e3);
  check(
    'and gives the page its whole width back',
    Math.abs(main.stack.get_width() - main.overlay.get_width()) <= 1,
    `${main.stack.get_width()} of ${main.overlay.get_width()}`,
  );
  await ipc('window.browserApi.menu.toggle()');
  await waitFor(() => menu.isOpen());
  await evaluate(
    menuView,
    "[...document.querySelectorAll('.menu-item')].find((b) => b.textContent === 'History').click()",
  );
  check(
    'choosing History opens the History page',
    await waitFor(() => state().tabs.some((tab) => tab.page === 'history')),
  );
  check('and closes the menu', await waitFor(() => !menu.isOpen()));
  await sleep(1e3);
  check(
    'History page lists visits',
    (await ipc<number>("document.querySelectorAll('.hist-row').length")) > 0,
  );
  await screenshot(ui, 'ui-history');
  tabs.openPage('keybindings');
  await sleep(1e3);
  check(
    'Keybindings page lists the actions',
    (await ipc<number>("document.querySelectorAll('.kb-row').length")) >= 15,
  );
  await screenshot(ui, 'ui-keybindings');
  await ipc(`window.browserApi.navigation.navigate('${SITE}/two.html')`);
  await waitFor(
    () => state().tabs.find((tab) => tab.id === state().activeTabId)?.title === 'Page Two',
  );
  check(
    'Chrome DevTools is what F12 opens by default',
    context.devtools.activeProvider() === 'chrome',
  );
  context.devtools.use('webkit');
  await sleep(400);
  press(Gdk.KEY_F12, 0);
  check(
    'a real F12 key event opens the Web Inspector',
    await waitFor(() => activeView().get_inspector().get_web_view() !== null),
  );
  check(
    'and it is docked under the page',
    await waitFor(() => activeView().get_inspector().get_attached_height() > 0),
  );
  await sleep(3e3);
  windowShot(context, 'window-devtools');
  await sleep(400);
  press(Gdk.KEY_F12, 0);
  check(
    'and a second F12 closes it',
    await waitFor(() => activeView().get_inspector().get_web_view() === null),
  );
  context.devtools.use('chrome');
  const { devtoolsPanel } = context;
  const pageHeight = main.stack.get_height();
  await sleep(400);
  press(Gdk.KEY_F12, 0);
  check('F12 opens the Chrome DevTools panel', devtoolsPanel.isOpen(activeView()));
  check(
    'the panel takes room under the page, inside the window',
    await waitFor(() => main.stack.get_height() < pageHeight),
    `${main.stack.get_height()} of ${pageHeight}`,
  );
  check(
    'DevTools and the page talk to each other through the bridge',
    await waitFor(() => (devtoolsPanel.stats(activeView())?.fromPage ?? 0) > 5, 3e4),
    JSON.stringify(devtoolsPanel.stats(activeView())),
  );
  check(
    'the page cannot see the bridge (no message handler in its own world)',
    (await evaluate(activeView(), 'typeof (window.webkit && window.webkit.messageHandlers)')) ===
      'undefined',
  );
  await sleep(3e3);
  windowShot(context, 'window-chrome-devtools');
  const viewA = activeView();
  const tabA = state().activeTabId;
  const tabB = tabs.createTab(`${SITE}/two.html`);
  await waitFor(() => state().activeTabId === tabB);
  check(
    'a tab that is not the one DevTools was opened from has none, and its page keeps its whole height',
    !devtoolsPanel.isOpen(activeView()) &&
      (await waitFor(() => Math.abs(main.stack.get_height() - pageHeight) <= 1)),
    `${main.stack.get_height()} of ${pageHeight}`,
  );
  await ipc(`window.browserApi.tabs.activate(${String(tabA)})`);
  check(
    'back on the first tab, its DevTools is still there',
    devtoolsPanel.isOpen(viewA) && (await waitFor(() => main.stack.get_height() < pageHeight)),
  );
  await ipc(`window.browserApi.tabs.close(${String(tabB)})`);
  await sleep(400);
  press(Gdk.KEY_F12, 0);
  check(
    'a second F12 closes the panel and gives the page its height back',
    !devtoolsPanel.isOpen(activeView()) &&
      (await waitFor(() => Math.abs(main.stack.get_height() - pageHeight) <= 1)),
  );
  const chromeStatus = () =>
    context.devtools.getState().providers.find((provider) => provider.id === 'chrome');
  await ipc("window.browserApi.menu.select('devSettings')");
  check(
    'Dev settings opens its page in a tab',
    await waitFor(
      () => state().tabs.find((tab) => tab.id === state().activeTabId)?.page === 'dev-settings',
    ),
  );
  check(
    'and lists one Chrome DevTools, in use, and the built-in inspector',
    await waitFor(
      async () =>
        (await ipc(
          "JSON.stringify([...document.querySelectorAll('.dev-row')].map(r => [r.querySelector('.dev-name').textContent, r.dataset.active]))",
        )) ===
        JSON.stringify([
          ['Chrome DevTools', 'true'],
          ['Safari Web Inspector (WebKit)', 'false'],
        ]),
    ),
  );
  const seedVersion = chromeStatus()?.version ?? '';
  check(
    'the Chrome DevTools that comes with the app counts as installed, with its release',
    chromeStatus()?.installed === true &&
      chromeStatus()?.location === 'app' &&
      /^\d+\.\d+\.\d+$/.test(seedVersion),
    JSON.stringify(chromeStatus()),
  );
  check('the built-in inspector cannot be uninstalled', !context.devtools.uninstall('webkit').ok);
  check('the WebKit inspector can be chosen', context.devtools.use('webkit').ok);
  check(
    'the Use button of Chrome DevTools appears while the other one is in use',
    await waitFor(
      async () =>
        await ipc("!document.querySelector('.dev-row:nth-child(1) .dev-button--primary').hidden"),
    ),
  );
  await ipc("document.querySelector('.dev-row:nth-child(1) .dev-button--primary').click()");
  check(
    'and pressing it makes Chrome DevTools the one F12 opens',
    await waitFor(() => context.devtools.activeProvider() === 'chrome'),
    context.devtools.activeProvider(),
  );
  await sleep(300);
  await screenshot(ui, 'ui-dev-settings');
  check(
    'Chrome DevTools can be uninstalled to free the space',
    context.devtools.uninstall('chrome').ok,
  );
  check(
    'after which it is not installed and F12 falls back to the WebKit inspector',
    chromeStatus()?.installed === false && context.devtools.activeProvider() === 'webkit',
  );
  check('it cannot be used until it is installed again', !context.devtools.use('chrome').ok);
  check(
    'the page offers to install it, the release that comes with the app included',
    await waitFor(
      async () =>
        (await ipc("document.querySelector('.dev-row:nth-child(1) .dev-badge').textContent")) ===
        'Not installed',
    ),
  );
  await sleep(300);
  await screenshot(ui, 'ui-dev-settings-uninstalled');
  check(
    'the release that comes with the app installs again without any download',
    (await context.devtools.download('chrome', seedVersion)).ok &&
      chromeStatus()?.installed === true &&
      chromeStatus()?.location === 'app' &&
      context.devtools.activeProvider() === 'chrome',
    JSON.stringify(chromeStatus()),
  );
  check(
    'a release that is not a release number is refused',
    !(await context.devtools.download('chrome', '../evil')).ok,
  );
  if (GLib.getenv('WEBSWITCH_SELFTEST_DOWNLOAD') === '1') {
    const checked = await context.devtools.check();
    const registry = context.devtools.getState().registry;
    check(
      'checking for updates lists every release and the newest',
      checked.ok && registry.versions.length > 20 && registry.latest === registry.versions[0],
      `${registry.versions.length} releases, latest ${registry.latest}`,
    );
    const older = registry.versions[1] ?? '';
    check(
      'installing without naming a release downloads the newest',
      (await ipc<{ ok: boolean }>("window.browserApi.devtools.download('chrome')")).ok &&
        chromeStatus()?.version === registry.latest &&
        chromeStatus()?.location === 'downloaded',
      JSON.stringify(chromeStatus()),
    );
    check(
      'an older release can be picked, downloads and passes its checksum',
      (await context.devtools.download('chrome', older)).ok &&
        chromeStatus()?.version === older &&
        chromeStatus()?.updateAvailable === true,
      JSON.stringify(chromeStatus()),
    );
    await sleep(300);
    await screenshot(ui, 'ui-dev-settings-update');
    await sleep(400);
    press(Gdk.KEY_F12, 0);
    check(
      'F12 with a downloaded release in use opens it, and it talks to the page',
      context.devtoolsPanel.isOpen(ui) &&
        (context.devtools.frontendDir('chrome') ?? '').includes('/devtools/chrome') &&
        (await waitFor(() => (context.devtoolsPanel.stats(ui)?.fromPage ?? 0) > 5, 3e4)),
      JSON.stringify(context.devtoolsPanel.stats(ui)),
    );
    await sleep(400);
    press(Gdk.KEY_F12, 0);
    check(
      'updating installs the newest release',
      (await context.devtools.download('chrome', registry.latest ?? void 0)).ok &&
        chromeStatus()?.version === registry.latest,
    );
    check('uninstalling removes the downloaded copy', context.devtools.uninstall('chrome').ok);
    check(
      'and the release that comes with the app can be put back',
      (await context.devtools.download('chrome', seedVersion)).ok &&
        chromeStatus()?.location === 'app',
    );
  }
  await evaluate(menuView, "document.querySelector('.menu-browser--gear').click()");
  check(
    'the gear opens the page to install and manage the browsers',
    await waitFor(
      () => state().tabs.find((tab) => tab.id === state().activeTabId)?.page === 'browsers',
    ),
  );
  tabs.openPage('history');
  await waitFor(
    () => state().tabs.find((tab) => tab.id === state().activeTabId)?.page === 'history',
  );
  await ipc('window.browserApi.menu.toggle()');
  await waitFor(() => menu.isOpen());
  check(
    'the icon of a browser that is not installed says to click to install it',
    String(
      await evaluate(
        menuView,
        'document.querySelector(\'.menu-browser[aria-label="Firefox"]\').title',
      ),
    ).includes('click to install'),
  );
  await evaluate(
    menuView,
    'document.querySelector(\'.menu-browser[aria-label="Firefox"]\').click()',
  );
  check(
    'and clicking it takes you to the page where browsers are installed',
    await waitFor(
      () => state().tabs.find((tab) => tab.id === state().activeTabId)?.page === 'browsers',
    ),
  );
  check('closing the menu on the way', !menu.isOpen());
  check(
    'it lists Chrome, Firefox and WebKit first, then Opera and Edge as extras, with what each is',
    await waitFor(
      async () =>
        (await ipc<string>(
          "JSON.stringify([...document.querySelectorAll('.br-card')].map(c => [c.dataset.browser, c.querySelector('.br-badge').textContent]))",
        )) ===
        JSON.stringify([
          ['chrome', 'Blink'],
          ['firefox', 'Gecko'],
          ['webkit', 'WebKit'],
          ['opera', 'Blink'],
          ['edge', 'Blink'],
        ]),
    ),
  );
  check(
    'and says plainly that Safari and Internet Explorer are not available on Linux',
    (await ipc<string>("document.querySelector('.br-others').textContent")).includes(
      'Internet Explorer',
    ),
  );
  check(
    'nothing is installed and the page offers to install (it made no request to get here)',
    (await ipc<number>("document.querySelectorAll('.br-install .br-button--primary').length")) ===
      4,
  );
  await sleep(300);
  await screenshot(ui, 'ui-browsers');
  const jsonc = parseJsonc(`{
    // a comment, and a URL in a string that must survive: "https://example.com/a//b"
    "name": "Sample", "type": "dark",
    "colors": { "editor.background": "#282c34", "editor.foreground": "#abb2bf", /* block */
      "focusBorder": "#3e4452", "activityBarBadge.background": "#4d78cc",
      "list.hoverBackground": "#ffffff10", "descriptionForeground": "#abb2bf",
      "terminal.ansiGreen": "#8cc265", "terminal.ansiRed": "#e05561", "terminal.ansiBlue": "#4aa5f0",
    },
  }`) as { name?: string; colors?: Record<string, unknown> };
  check(
    'a theme file with comments and trailing commas is read',
    jsonc.name === 'Sample' && jsonc.colors?.['editor.background'] === '#282c34',
  );
  const converted = convertVsCodeTheme(jsonc, 'Sample', 'vs-dark');
  check(
    'the accent is a color that stands out, not the gray focus border',
    converted.colors?.accent === '#4d78cc',
    JSON.stringify(converted.colors),
  );
  check(
    'a see-through hover color is laid over the background',
    /^#[0-9a-f]{6}$/.test(String(converted.colors?.hover)) && converted.colors?.hover !== '#ffffff',
    String(converted.colors?.hover),
  );
  check(
    'a "muted" text color equal to the text color is not taken (it is worked out instead)',
    converted.colors?.fgMuted === void 0,
  );
  const parsedVsx = parseTheme(
    {
      ...converted,
      author: 'me',
      license: 'MIT',
      source: 'openvsx:me.sample',
    },
    'sample',
  );
  check(
    'and the result is a complete Webswitch theme that keeps its license and source',
    parsedVsx.ok &&
      parsedVsx.theme.scheme === 'dark' &&
      parsedVsx.theme.license === 'MIT' &&
      parsedVsx.theme.source === 'openvsx:me.sample' &&
      (Object.values(parsedVsx.theme.colors) as string[]).every((c) => /^#[0-9a-f]{6}$/.test(c)),
  );
  check(
    'a light theme by its "type", and by the extension\'s "vs" when the file says nothing',
    convertVsCodeTheme(
      {
        colors: { 'editor.background': '#ffffff' },
        type: 'light',
      },
      'L',
      void 0,
    ).scheme === 'light' &&
      convertVsCodeTheme({ colors: {} }, 'L2', 'vs').scheme === 'light' &&
      convertVsCodeTheme({ colors: {} }, 'D', 'hc-black').scheme === 'dark',
  );
  const chain = mergeIncluded([
    {
      colors: { 'editor.background': '#111111' },
      name: 'Child',
    },
    {
      colors: {
        'editor.background': '#222222',
        foreground: '#eeeeee',
      },
      type: 'dark',
      name: 'Parent',
    },
  ]);
  check(
    'an included file gives what the including one does not say, and loses to it',
    chain.colors['editor.background'] === '#111111' &&
      chain.colors.foreground === '#eeeeee' &&
      chain.name === 'Child',
  );
  check(
    'colors that are not hex (names, functions) are ignored, never passed on',
    !JSON.stringify(
      convertVsCodeTheme(
        {
          colors: {
            'editor.background': 'red; }',
            'editor.foreground': 'rgb(1,2,3)',
          },
        },
        'X',
        'vs-dark',
      ).colors,
    ).includes('red'),
  );
  const { themes } = context;
  const themeCssText = () => Promise.resolve(themes.css());
  const cssVariable = (name: string): Promise<string> =>
    ipc<string>(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`);
  check(
    'themes start on the system one, with the built-in themes listed',
    themes.getState().active === 'system' &&
      themes.getState().themes.length >= 8 &&
      themes.getState().themes.every((theme) => theme.builtin),
  );
  check(
    'and the system theme sets no colors of its own',
    !(await themeCssText()).includes('--color'),
  );
  check(
    'choosing a theme changes the colors the UI uses',
    (await ipc<{ ok: boolean }>("window.browserApi.themes.select('dracula')")).ok &&
      (await waitFor(async () => (await cssVariable('--color-bg')) === '#282a36')),
    await cssVariable('--color-bg'),
  );
  check(
    'and the ones GTK draws (window buttons, popup frame)',
    chromeColors().bg === '#282a36' && chromeColors().accent === '#bd93f9',
    JSON.stringify(chromeColors()),
  );
  check(
    'the stylesheet carries the theme',
    (await themeCssText()).includes('--color-accent: #bd93f9;'),
  );
  const mine = JSON.stringify({
    name: 'My Theme',
    author: 'me',
    colors: {
      bg: '#101418',
      fg: '#e6e6e6',
      accent: '#ff8800',
    },
  });
  const added = await ipc<{ ok: boolean; id?: string; error?: string }>(
    `window.browserApi.themes.add(${JSON.stringify(mine)})`,
  );
  const custom = themes.getState().themes.find((theme) => theme.id === added.id);
  check(
    'a theme can be added from its JSON; missing colors are worked out from the three given',
    added.ok &&
      custom !== void 0 &&
      !custom.builtin &&
      custom.scheme === 'dark' &&
      /^#[0-9a-f]{6}$/.test(custom.colors.border),
    JSON.stringify(custom),
  );
  const themeFile = GLib.build_filenamev([
    GLib.get_user_config_dir(),
    'webswitch',
    'themes',
    'my-theme.json',
  ]);
  check(
    'and it is kept as a file in the themes folder',
    await waitFor(async () => (await readText(themeFile)) !== null),
  );
  const again = await ipc<{ ok: boolean; id?: string }>(
    `window.browserApi.themes.add(${JSON.stringify(mine)})`,
  );
  check('adding one with the same name keeps both', again.ok && again.id === 'my-theme-2');
  for (const [why, text] of [
    ['text that is not JSON', 'not json'],
    [
      'a color that tries to add CSS',
      JSON.stringify({
        name: 'x',
        colors: {
          bg: 'red; } body { display: none',
          fg: '#fff',
          accent: '#f00',
        },
      }),
    ],
    [
      'a missing accent',
      JSON.stringify({
        name: 'x',
        colors: {
          bg: '#000',
          fg: '#fff',
        },
      }),
    ],
    [
      'a missing name',
      JSON.stringify({
        colors: {
          bg: '#000',
          fg: '#fff',
          accent: '#f00',
        },
      }),
    ],
    [
      'a name that is far too long',
      JSON.stringify({
        name: 'x'.repeat(200),
        colors: {
          bg: '#000',
          fg: '#fff',
          accent: '#f00',
        },
      }),
    ],
    [
      'a scheme that is neither',
      JSON.stringify({
        name: 'x',
        scheme: 'blue',
        colors: {
          bg: '#000',
          fg: '#fff',
          accent: '#f00',
        },
      }),
    ],
  ]) {
    const refused = await ipc<{ ok: boolean }>(
      `window.browserApi.themes.add(${JSON.stringify(text)})`,
    );
    check(`a theme with ${why} is refused`, !refused.ok);
  }
  const shortHex = await ipc<{ ok: boolean; id?: string }>(
    `window.browserApi.themes.add(${JSON.stringify(
      JSON.stringify({
        name: 'Short',
        colors: {
          bg: '#FFF',
          fg: '#000',
          accent: '#F0A',
        },
      }),
    )})`,
  );
  check(
    '#rgb colors are accepted and written in full',
    shortHex.ok &&
      themes.getState().themes.find((t) => t.id === shortHex.id)?.colors.bg === '#ffffff',
  );
  const fromFile = GLib.build_filenamev([GLib.get_tmp_dir(), 'webswitch-selftest-theme.json']);
  GLib.file_set_contents(
    fromFile,
    JSON.stringify({
      name: 'From File',
      colors: {
        bg: '#0a0a0a',
        fg: '#cccccc',
        accent: '#33ccff',
      },
    }),
  );
  check('a theme can be added from a file', (await themes.addFromFile(fromFile)).ok);
  check(
    'a file that is not there is refused, not thrown',
    !(await themes.addFromFile('/no/such/theme.json')).ok,
  );
  GLib.unlink(fromFile);
  GLib.file_set_contents(
    GLib.build_filenamev([GLib.get_user_config_dir(), 'webswitch', 'themes', 'dropped-in.json']),
    JSON.stringify({
      name: 'Dropped In',
      colors: {
        bg: '#202020',
        fg: '#dddddd',
        accent: '#00ff99',
      },
    }),
  );
  themes.reload();
  check(
    'a file dropped into the themes folder shows up after Reload',
    themes.getState().themes.some((theme) => theme.id === 'dropped-in'),
  );
  check(
    'a built-in theme cannot be removed',
    !(await ipc<{ ok: boolean }>("window.browserApi.themes.remove('nord')")).ok,
  );
  await ipc("window.browserApi.menu.select('themes')");
  check(
    'the Themes page opens in a tab and shows a card for every theme, the automatic one first',
    await waitFor(
      async () =>
        (await ipc("document.querySelectorAll('.theme-card').length")) ===
          themes.getState().themes.length + 1 &&
        (await ipc("document.querySelector('.theme-card').dataset.theme")) === 'system',
    ),
  );
  await ipc(
    'document.querySelector(\'.theme-card[data-theme="my-theme"] .themes-button--primary\').click()',
  );
  check(
    'pressing Use on a card chooses that theme',
    (await waitFor(() => themes.getState().active === 'my-theme')) &&
      (await waitFor(async () => (await cssVariable('--color-accent')) === '#ff8800')),
  );
  await sleep(400);
  await screenshot(ui, 'ui-themes');
  await ipc(
    "document.querySelector('.themes-header .themes-button:not(.themes-button--primary)').click()",
  );
  check(
    'the VS Code themes panel opens without asking the network for anything',
    await waitFor(
      async () =>
        !(await ipc("document.querySelector('.themes-vsx').hidden")) &&
        (await ipc("document.querySelectorAll('.themes-vsx__item').length")) === 0 &&
        (await ipc<string>("document.querySelector('.themes-vsx__status').textContent")).includes(
          'Press Search',
        ),
    ),
  );
  await screenshot(ui, 'ui-themes-vsx');
  await ipc("document.querySelector('.themes-header .themes-button--primary').click()");
  check(
    'Add theme opens the panel for a file or pasted JSON',
    await waitFor(async () => !(await ipc("document.querySelector('.themes-add').hidden"))),
  );
  await ipc(
    'document.querySelector(\'.theme-card[data-theme="my-theme"] .themes-button:not(.themes-button--primary)\')?.click()',
  );
  check(
    'removing the theme in use puts the system theme back',
    await waitFor(
      () =>
        themes.getState().active === 'system' &&
        !themes.getState().themes.some((t) => t.id === 'my-theme'),
    ),
  );
  check('and deletes its file', await waitFor(async () => (await readText(themeFile)) === null));
  for (const theme of themes.getState().themes) if (!theme.builtin) themes.remove(theme.id);
  check(
    'back to the system theme, the colors of before',
    !(await themeCssText()).includes('--color') && themes.getState().active === 'system',
  );
  if (GLib.getenv('WEBSWITCH_SELFTEST_DOWNLOAD') === '1') {
    const { openVsx } = context;
    const found = await openVsx.search('dracula', 0, 'downloadCount');
    check(
      'searching Open VSX finds color themes',
      found.total > 3 && found.results.length > 3 && found.results.every((r) => r.id.includes('.')),
      `${found.total} found, first ${found.results[0]?.id}`,
    );
    const pick =
      found.results.find((r) => r.id === 'dracula-theme.theme-dracula') ?? found.results[0];
    const installedNow = pick ? await openVsx.install(pick.namespace, pick.name) : null;
    const withLicense = themes
      .getState()
      .themes.filter((t) => !t.builtin && t.source === `openvsx:${pick?.id}`);
    check(
      'installing one adds its themes, with the license and where they came from',
      installedNow?.ok === true &&
        withLicense.length > 0 &&
        withLicense.every((t) => t.license !== void 0 && t.author === pick?.namespace),
      JSON.stringify(installedNow) +
        ' ' +
        JSON.stringify(withLicense.map((t) => [t.name, t.license])),
    );
    check(
      'and the search then says it is installed',
      (await openVsx.search('dracula', 0, 'downloadCount')).results.find((r) => r.id === pick?.id)
        ?.installed === true,
    );
    check(
      'an icon theme (no colors in it) is refused with a reason',
      !(await openVsx.install('PKief', 'material-icon-theme')).ok,
    );
    check(
      'a name that is not an extension name is refused',
      !(await openVsx.install('../x', 'y')).ok,
    );
    const popularBefore = themes.getState().themes.length;
    const popular = await openVsx.installPopular(3);
    check(
      'the most popular can be installed in bulk',
      popular.ok &&
        themes.getState().themes.length > popularBefore &&
        themes.getState().busy === null,
      JSON.stringify(popular),
    );
    const shown =
      themes.getState().themes.find((t) => t.id === 'catppuccin-mocha') ??
      themes.getState().themes.find((t) => !t.builtin);
    if (shown) themes.select(shown.id);
    await ipc("window.browserApi.menu.select('themes')");
    await sleep(1200);
    await screenshot(ui, 'ui-themes-installed');
    for (const theme of themes.getState().themes) if (!theme.builtin) themes.remove(theme.id);
  }
  await sleep(300);
  await ipc(`window.browserApi.navigation.navigate('${SITE}/two.html')`);
  await waitFor(
    () => state().tabs.find((tab) => tab.id === state().activeTabId)?.title === 'Page Two',
  );
  tabs.zoomActiveTab('in');
  check(
    'zoom in',
    Math.abs(activeView().get_zoom_level() - 1.1) < 0.001,
    String(activeView().get_zoom_level()),
  );
  tabs.zoomActiveTab('reset');
  await ipc(`window.browserApi.navigation.navigate('${SITE}/long-title.html')`);
  await waitFor(() =>
    (state().tabs.find((tab) => tab.id === state().activeTabId)?.title ?? '').startsWith(
      'Portal do Aluno',
    ),
  );
  await sleep(300);
  const plusGap = await ipc<number>(
    `(() => { const tabs = [...document.querySelectorAll('.tab')]; const last = tabs[tabs.length - 1].getBoundingClientRect(); return Math.round(document.querySelector('.tab-new').getBoundingClientRect().left - last.right); })()`,
  );
  check(
    'the + button stays next to the last tab (long title)',
    plusGap >= 0 && plusGap <= 24,
    `${plusGap}px`,
  );
  const { cookies } = context;
  const cookieNamed = async (name: string) =>
    (await cookies.getState()).cookies.find((entry) => entry.name === name);
  const pageBody = async () =>
    String(await evaluate(activeView(), "document.getElementById('c')?.textContent ?? ''"));
  const titleIs = (title: string) => () =>
    state().tabs.find((tab) => tab.id === state().activeTabId)?.title === title;
  for (const tab of state().tabs) if (tab.id !== state().activeTabId) tabs.closeTab(tab.id);
  await sleep(300);
  await ipc(`window.browserApi.navigation.navigate('${SITE}/two.html')`);
  await waitFor(titleIs('Page Two'));
  await evaluate(activeView(), "document.cookie = 'sessionid=abc123; path=/'");
  check(
    'a cookie set by a page appears in the cookie manager',
    await waitFor(async () => (await cookieNamed('sessionid')) !== void 0),
  );
  let cookie = await cookieNamed('sessionid');
  const cookieId = cookie?.id ?? '';
  check('it is recognised as a sign-in cookie', cookie?.kind === 'authentication', cookie?.kind);
  const summary = await ipc<CookiesSummary>('window.browserApi.cookies.summary()');
  check(
    'the menu summary lists who is signed in and counts every cookie',
    cookie !== void 0 && summary.signedIn.includes(cookie.company) && summary.total >= 1,
    JSON.stringify(summary),
  );
  check('and explained in plain words', (cookie?.explanation.length ?? 0) > 30);
  check(
    'its first-seen date is recorded',
    await waitFor(async () => ((await cookieNamed('sessionid'))?.firstSeen ?? 0) > 0),
  );
  const seed = async (name: string, domain: string, secure = false) => {
    const cookie = new Soup.Cookie(name, 'fake-value', domain, '/', 3600);
    cookie.set_secure(secure);
    await context.session.get_cookie_manager().add_cookie(cookie, null);
  };
  await seed('SID', '.google.com');
  await seed('__Secure-1PSID', '.google.com', true);
  await seed('MSPAuth', '.live.com');
  await seed('MoodleSession', 'moodle.example.edu.br');
  await seed('_ga', '.example.co.uk');
  await waitFor(async () => (await cookieNamed('MoodleSession')) !== void 0);
  const catalog = await cookies.getState();
  console.log(
    `seeded cookies as listed: ${catalog.cookies.map((entry) => `${entry.name}@${entry.domain}`).join(', ')}`,
  );
  const google = catalog.cookies.find((entry) => entry.name === 'SID');
  check(
    'a Google cookie is grouped under Google and explained',
    google?.company === 'Google' &&
      google.kind === 'authentication' &&
      google.explanation.includes('Google'),
    `${google?.company} ${google?.kind}`,
  );
  check(
    'Google has an account panel and a sign-out warning',
    catalog.companies.find((c) => c.name === 'Google')?.accountPanel?.url ===
      'https://myaccount.google.com/' &&
      (catalog.companies.find((c) => c.name === 'Google')?.removalWarning ?? '').includes(
        'Sign in with Google',
      ),
  );
  check(
    'a Microsoft cookie is grouped under Microsoft with its own panel',
    (await cookieNamed('MSPAuth'))?.company === 'Microsoft' &&
      catalog.companies.find((c) => c.name === 'Microsoft')?.accountPanel?.url ===
        'https://account.microsoft.com/',
  );
  check(
    'a cookie that belongs only to a subdomain is listed too',
    (await cookieNamed('MoodleSession'))?.domain === 'moodle.example.edu.br',
  );
  check(
    'an unknown site is its own group, without a panel',
    (await cookieNamed('MoodleSession'))?.company === 'example.edu.br' &&
      catalog.companies.find((c) => c.name === 'example.edu.br')?.accountPanel === null,
  );
  check(
    'an analytics cookie is told apart from sign-in',
    (await cookieNamed('_ga'))?.kind === 'analytics' &&
      (await cookieNamed('_ga'))?.company === 'example.co.uk',
  );
  tabs.openPage('cookies');
  await sleep(800);
  check(
    'the Cookies page lists it, grouped by company',
    (await ipc<number>("document.querySelectorAll('.ck-row').length")) >= 1 &&
      (await ipc<number>("document.querySelectorAll('.ck-group').length")) >= 1,
  );
  await screenshot(ui, 'ui-cookies');
  tabs.closeActiveTab();
  await sleep(300);
  await cookies.setPolicy([cookieId], {
    mode: 'disabled',
    sites: [],
  });
  cookie = await cookieNamed('sessionid');
  check(
    'disabling keeps it listed but takes it out of the browser',
    cookie?.mode === 'disabled' && !cookie.inJar,
  );
  check(
    'and the page no longer sees it',
    !String(await evaluate(activeView(), 'document.cookie')).includes('sessionid'),
  );
  await cookies.setPolicy([cookieId], {
    mode: 'active',
    sites: [],
  });
  cookie = await cookieNamed('sessionid');
  check(
    'enabling puts it back',
    cookie?.mode === 'active' &&
      cookie.inJar &&
      String(await evaluate(activeView(), 'document.cookie')).includes('sessionid=abc123'),
  );
  await cookies.setPolicy([cookieId], {
    mode: 'only-on',
    sites: ['other.test'],
  });
  cookie = await cookieNamed('sessionid');
  check(
    'a cookie allowed only on other sites is not in the browser here',
    cookie?.mode === 'only-on' && !cookie.inJar,
  );
  await cookies.setPolicy([cookieId], {
    mode: 'only-on',
    sites: ['localhost'],
  });
  check(
    'and is in the browser while a tab is on its site',
    (await cookieNamed('sessionid'))?.inJar === true,
  );
  await ipc("window.browserApi.navigation.navigate('http://127.0.0.1:8765/two.html')");
  await waitFor(titleIs('Page Two'));
  check(
    'leaving the site takes the cookie out of the browser',
    await waitFor(async () => (await cookieNamed('sessionid'))?.inJar === false),
  );
  await ipc(`window.browserApi.navigation.navigate('${SITE}/echo-cookie')`);
  await waitFor(titleIs('echo-cookie'));
  check(
    'a typed address gets its cookie back before the request',
    (await pageBody()).includes('sessionid=abc123'),
    await pageBody(),
  );
  await ipc("window.browserApi.navigation.navigate('http://127.0.0.1:8765/cookie-link.html')");
  await waitFor(titleIs('cookie link'));
  check(
    'before the click the cookie is out of the browser',
    await waitFor(async () => (await cookieNamed('sessionid'))?.inJar === false),
  );
  await evaluate(activeView(), "document.getElementById('go').click()");
  await waitFor(titleIs('echo-cookie'));
  check(
    'a clicked link gets its cookie back before the request',
    (await pageBody()).includes('sessionid=abc123'),
    await pageBody(),
  );
  await cookies.setPolicy([cookieId], {
    mode: 'only-on',
    sites: ['other.test'],
  });
  await ipc(`window.browserApi.navigation.navigate('${SITE}/echo-cookie')`);
  await sleep(1200);
  check(
    'a cookie not allowed on this site is not sent to it',
    !(await pageBody()).includes('sessionid'),
  );
  await cookies.remove([cookieId]);
  check('removing deletes it for good', (await cookieNamed('sessionid')) === void 0);
  await cookies.remove(
    (await cookies.getState()).cookies
      .filter((entry) =>
        ['SID', '__Secure-1PSID', 'MSPAuth', 'MoodleSession', '_ga'].includes(entry.name),
      )
      .map((entry) => entry.id),
  );
  await ipc(`window.browserApi.navigation.navigate('${SITE}/two.html')`);
  await waitFor(titleIs('Page Two'));
  await evaluate(activeView(), "document.cookie = 'sessionid=one; path=/'");
  await waitFor(async () => (await cookieNamed('sessionid')) !== void 0);
  await cookies.setCompanyPolicy('localhost', {
    mode: 'only-on',
    sites: [],
  });
  check(
    'a company rule with no valid site is refused',
    (await cookies.getState()).companies.find((c) => c.name === 'localhost')?.mode === 'active',
  );
  await cookies.setCompanyPolicy('localhost', {
    mode: 'disabled',
    sites: [],
  });
  let first = await cookieNamed('sessionid');
  check(
    'a company rule disables the cookies the company already has',
    first?.mode === 'disabled' && first.origin === 'company' && !first.inJar,
  );
  await evaluate(activeView(), "document.cookie = 'authtoken=two; path=/'");
  check(
    'and the ones the site sets later',
    await waitFor(async () => {
      const later = await cookieNamed('authtoken');
      return later?.mode === 'disabled' && later.origin === 'company' && !later.inJar;
    }),
  );
  await cookies.setPolicy([first?.id ?? ''], {
    mode: 'active',
    sites: [],
  });
  first = await cookieNamed('sessionid');
  check(
    'a single cookie can be allowed on purpose despite the rule',
    first?.mode === 'active' && first.inJar,
  );
  await sleep(1200);
  check('and later passes do not take it back', (await cookieNamed('sessionid'))?.inJar === true);
  await cookies.setCompanyPolicy('localhost', {
    mode: 'only-on',
    sites: ['other.test'],
  });
  const limited = await cookieNamed('authtoken');
  check(
    'a company rule "only on" other sites keeps its cookies out here',
    limited?.mode === 'only-on' && limited.sites.includes('other.test') && !limited.inJar,
  );
  await cookies.setCompanyPolicy('localhost', {
    mode: 'only-on',
    sites: ['localhost'],
  });
  check('and lets them in on the allowed site', (await cookieNamed('authtoken'))?.inJar === true);
  await cookies.setCompanyPolicy('localhost', {
    mode: 'active',
    sites: [],
  });
  const released = (await cookies.getState()).cookies.filter((c) =>
    ['sessionid', 'authtoken'].includes(c.name),
  );
  check(
    'removing the company rule releases all its cookies',
    released.length === 2 && released.every((c) => c.mode === 'active' && c.inJar),
  );
  await cookies.remove(released.map((c) => c.id));
  const urlBefore = state().tabs.find((tab) => tab.id === state().activeTabId)?.url;
  await ipc("window.browserApi.navigation.navigate('https://www.netflix.com/browse')");
  const drmArgsPath = GLib.build_filenamev([OUT, 'drm-args.txt']);
  await waitFor(async () => (await readText(drmArgsPath)) !== null);
  const drmArgs = await readText(drmArgsPath);
  check(
    'a DRM site opens in a Chromium app window',
    drmArgs?.includes('--app=https://www.netflix.com/browse') === true,
    drmArgs ?? 'no call',
  );
  check(
    'passkeys (WebAuthn) are switched off in that Chrome',
    drmArgs?.includes('--disable-blink-features=WebAuth') === true,
  );
  const prefs = await readText(
    GLib.build_filenamev([
      GLib.get_user_data_dir(),
      'webswitch',
      'drm-profile',
      'Default',
      'Preferences',
    ]),
  );
  check(
    'and its notifications are blocked, so it never asks',
    prefs?.includes('"notifications":2') === true,
    prefs ?? 'no preferences',
  );
  check(
    'the visit reached the history',
    history.query('', 50).some((entry) => entry.url === 'https://www.netflix.com/browse'),
  );
  check(
    'and the tab did not navigate',
    state().tabs.find((tab) => tab.id === state().activeTabId)?.url === urlBefore,
  );
  const settingsFile = GLib.build_filenamev([
    GLib.get_user_config_dir(),
    'webswitch',
    'settings.json',
  ]);
  await ipc(`window.browserApi.navigation.navigate('${SITE}/two.html')`);
  await waitFor(titleIs('Page Two'));
  check(
    'settings start at their defaults, nothing waits for a restart',
    SETTINGS.every((d) => settings.getState().values[d.id] === d.default) &&
      settings.getState().restartPending.length === 0,
  );
  check(
    'a tab draws in software by default and scrolls smoothly',
    activeView().get_settings().hardware_acceleration_policy ===
      WebKit.HardwareAccelerationPolicy.NEVER &&
      activeView().get_settings().enable_smooth_scrolling,
  );
  check(
    "the environment's WEBSWITCH_EMBED_DRM=0 is reported as overriding the setting",
    settings.getState().overriddenByEnv.includes('embedStreaming') &&
      !settings.get('embedStreaming'),
  );
  const setViaIpc = (id: string, value: unknown) =>
    ipc<{ ok: boolean }>(
      `window.browserApi.settings.set(${JSON.stringify(id)}, ${JSON.stringify(value)})`,
    );
  check('a valid change is accepted', (await setViaIpc('smoothScrolling', false)).ok);
  check(
    'and reaches the tabs that are already open',
    !activeView().get_settings().enable_smooth_scrolling,
  );
  check(
    'and is saved, in a file that holds only what differs from the defaults',
    await waitFor(async () => {
      const saved = await readText(settingsFile);
      return (
        saved !== null &&
        (JSON.parse(saved) as { values: Record<string, unknown> }).values.smoothScrolling === false
      );
    }),
  );
  await ipc("window.browserApi.settings.reset('smoothScrolling')");
  check(
    'reset brings the default back, in the tab and in the file',
    activeView().get_settings().enable_smooth_scrolling &&
      (await waitFor(
        async () => !((await readText(settingsFile)) ?? '').includes('smoothScrolling'),
      )),
  );
  check('a toggle refuses text', !(await setViaIpc('pageCache', 'yes')).ok);
  check(
    'a choice refuses a value that is not an option',
    !(await setViaIpc('searchEngine', 'nope')).ok,
  );
  check('an unknown setting is refused', !(await setViaIpc('nothing', true)).ok);
  check(
    'a download folder that does not exist is refused',
    !(await setViaIpc('downloadFolder', '/no/such/folder')).ok,
  );
  check('and one that exists is accepted', (await setViaIpc('downloadFolder', '/tmp')).ok);
  await ipc("window.browserApi.settings.reset('downloadFolder')");
  await setViaIpc('searchEngine', 'google');
  check(
    'the search engine setting decides where an address-bar search goes',
    resolveInput('two words', searchEngineFor(settings.get('searchEngine'))) ===
      'https://www.google.com/search?q=two%20words',
  );
  await ipc("window.browserApi.settings.reset('searchEngine')");
  await setViaIpc('trackingPrevention', true);
  await setViaIpc('thirdPartyCookies', 'always');
  const acceptPolicy = await new Promise<WebKit.CookieAcceptPolicy>((resolve) => {
    const manager = context.session.get_cookie_manager();
    manager.get_accept_policy(null, (_m, result) => {
      resolve(manager.get_accept_policy_finish(result));
    });
  });
  check(
    'privacy settings reach the session',
    context.session.get_itp_enabled() && acceptPolicy === WebKit.CookieAcceptPolicy.ALWAYS,
    `itp=${context.session.get_itp_enabled()} policy=${acceptPolicy}`,
  );
  await ipc("window.browserApi.settings.reset('trackingPrevention')");
  await ipc("window.browserApi.settings.reset('thirdPartyCookies')");
  await setViaIpc('gpuAcceleration', true);
  check(
    'a change that only works after a restart is reported as waiting for one',
    settings.getState().restartPending.join() === 'gpuAcceleration',
  );
  check(
    'and is not applied to the open tab',
    activeView().get_settings().hardware_acceleration_policy ===
      WebKit.HardwareAccelerationPolicy.NEVER,
  );
  await ipc("window.browserApi.settings.reset('gpuAcceleration')");
  check('changing it back cancels the wait', settings.getState().restartPending.length === 0);
  check(
    'a restart starts the same program with the open pages as arguments',
    relaunchCommand(['gjs', '-m', 'dist/main.js', 'old-argument'], ['https://a.test/']).join(
      '|',
    ) === 'gjs|-m|dist/main.js|https://a.test/',
  );
  await ipc('window.browserApi.menu.toggle()');
  await waitFor(() => menu.isOpen());
  const groups = await evaluate(
    menuView,
    "JSON.stringify([...document.querySelectorAll('.menu-group')].map(g => [...g.querySelectorAll('.menu-label')].map(l => l.textContent)))",
  );
  check(
    'the menu has the app group, then a group below a border',
    groups ===
      JSON.stringify([
        ['Check for updates'],
        [
          'Cookies and accounts',
          'General settings',
          'Themes',
          'Extensions',
          'Keybindings',
          'History',
          'Dev settings',
        ],
        [],
      ]),
    String(groups),
  );
  check(
    'below a border, a row of browsers to test in: Chrome, Firefox, Opera, Edge, Safari (WebKit) and a gear',
    (await evaluate(
      menuView,
      "JSON.stringify([document.querySelector('.menu-testing__title')?.textContent, ...[...document.querySelectorAll('.menu-testing .menu-browser')].map(b => b.getAttribute('aria-label'))])",
    )) ===
      JSON.stringify([
        'Test in other browsers',
        'Chrome',
        'Firefox',
        'Opera',
        'Edge',
        'Safari (WebKit)',
        'Manage the browsers to test in',
      ]),
  );
  await screenshot(menuView, 'menu-browsers-row');
  check(
    'a browser that is not installed is drawn dim, WebKit (Webswitch itself) is not',
    (await evaluate(
      menuView,
      "JSON.stringify([...document.querySelectorAll('.menu-testing .menu-browser[data-installed]')].map(b => b.dataset.installed))",
    )) === JSON.stringify(['false', 'false', 'false', 'false', 'true']),
  );
  check(
    'Cookies and accounts keeps its title and shows who is signed in and the cookie count under it',
    await waitFor(async () =>
      /^Signed in: .+ · All cookies: \d+$/.test(
        String(
          await evaluate(
            menuView,
            "document.querySelector('.menu-item[data-signed-in] .menu-detail')?.textContent ?? ''",
          ),
        ),
      ),
    ),
  );
  await screenshot(menuView, 'menu-cookies-line');
  await evaluate(
    menuView,
    "[...document.querySelectorAll('.menu-item')].find(b => b.textContent.startsWith('General settings')).click()",
  );
  check(
    'General settings opens its page in a tab',
    await waitFor(
      () => state().tabs.find((tab) => tab.id === state().activeTabId)?.page === 'settings',
    ),
  );
  check('and closes the menu', !menu.isOpen());
  check(
    'the page shows every setting',
    await waitFor(
      async () => (await ipc("document.querySelectorAll('.set-row').length")) === SETTINGS.length,
    ),
  );
  check(
    'the star is hidden on a built-in page (Settings)',
    await ipc<boolean>("document.querySelector('.bookmark-star')?.hidden ?? true"),
  );
  await sleep(400);
  press(Gdk.KEY_F12, 0);
  check(
    'F12 on a built-in page opens Chrome DevTools for the UI that draws it',
    devtoolsPanel.isOpen(ui),
  );
  check(
    'and it reaches the UI through the bridge',
    await waitFor(() => (devtoolsPanel.stats(ui)?.fromPage ?? 0) > 5, 3e4),
    JSON.stringify(devtoolsPanel.stats(ui)),
  );
  await sleep(400);
  press(Gdk.KEY_F12, 0);
  check('and a second F12 closes it', !devtoolsPanel.isOpen(ui));
  await sleep(400);
  press(Gdk.KEY_F12, 0);
  const settingsTab = state().activeTabId;
  tabs.openPage('history');
  await waitFor(() => state().activeTabId !== settingsTab);
  check(
    "DevTools opened on one built-in page does not follow the user to another tab's page",
    !devtoolsPanel.isOpen(ui),
  );
  tabs.openPage('settings');
  await waitFor(() => state().activeTabId === settingsTab);
  check('and is not there when coming back either', !devtoolsPanel.isOpen(ui));
  context.devtools.use('webkit');
  await sleep(400);
  press(Gdk.KEY_F12, 0);
  check(
    'with the WebKit inspector chosen, F12 on a built-in page opens the inspector of the UI',
    await waitFor(() => ui.get_inspector().get_attached_height() > 0),
  );
  await sleep(400);
  press(Gdk.KEY_F12, 0);
  check(
    'and a second F12 closes it',
    await waitFor(() => ui.get_inspector().get_web_view() === null),
  );
  context.devtools.use('chrome');
  await ipc('document.querySelector(\'.set-switch[aria-label="Smooth scrolling"]\').click()');
  check(
    'a switch on the page changes the setting',
    await waitFor(() => !settings.get('smoothScrolling')),
  );
  await ipc(
    'document.querySelector(\'.set-switch[aria-label="Draw pages with the GPU"]\').click()',
  );
  check(
    'a restart-only change raises the restart banner',
    await waitFor(
      async () =>
        !(await ipc("document.querySelector('.set-banner').hidden")) &&
        (await ipc<string>("document.querySelector('.set-banner__text').textContent")).includes(
          'Draw pages with the GPU',
        ),
    ),
  );
  await sleep(300);
  await screenshot(ui, 'ui-settings');
  await ipc('window.browserApi.settings.resetAll()');
  check(
    'Reset all puts every setting back and lowers the banner',
    await waitFor(
      async () =>
        settings.getState().restartPending.length === 0 &&
        (await ipc("document.querySelector('.set-banner').hidden")),
    ),
  );
  await ipc("window.browserApi.navigation.navigate('http://localhost:59999/')");
  check(
    'a failed load is reported',
    await waitFor(() => state().tabs.find((tab) => tab.id === state().activeTabId)?.error != null),
  );
  check('and shows the UI message, not a blank page', !main.stack.get_visible());
  check(
    'a network-level failure (no HTTP status to show a picture for) shows its code as a big number',
    await waitFor(
      async () =>
        (await ipc<string>("document.querySelector('.load-error__number')?.textContent ?? ''")) !==
        '',
    ),
  );
  await sleep(500);
  await screenshot(ui, 'ui-error');
  await ipc(`window.browserApi.navigation.navigate('${SITE}/does-not-exist.html')`);
  check(
    'a real HTTP error status from the server is reported too, not just a network failure',
    await waitFor(
      () => state().tabs.find((tab) => tab.id === state().activeTabId)?.error?.httpStatus === 404,
    ),
  );
  check(
    'and the page shows the http.cat image for it, with a button to see more (no request made: the button is not clicked here)',
    await waitFor(
      async () =>
        (await ipc<string>("document.querySelector('.load-error__cat')?.src ?? ''")).includes(
          '.jpg',
        ) &&
        (await ipc<string>("document.querySelector('.load-error__more')?.textContent ?? ''")) ===
          'See more about 404',
    ),
  );
  await sleep(300);
  await screenshot(ui, 'ui-http-error');
  for (let i = 0; i < 20 && state().tabs.length > 0; i++) tabs.closeActiveTab();
  check(
    'closing the last tab leaves one blank tab',
    state().tabs.length === 1 && state().tabs[0]?.url === '',
  );
  await sleep(500);
  check(
    'the home page has a text field after the wordmark, and no fake cursor',
    await waitFor(
      async () =>
        await ipc(
          "!!document.querySelector('.home .wordmark .wordmark__input') && getComputedStyle(document.querySelector('.wordmark'), '::after').content === 'none'",
        ),
    ),
  );
  check(
    'the wordmark reads like the address of a search',
    (await ipc("document.querySelector('.wordmark').textContent")) === '.webswitch/?q=',
  );
  check(
    'the search engine list sits under the wordmark, at its left, and offers the engines of the settings',
    await ipc(
      "(() => { const home = document.querySelector('.home'); const [first, second] = home.children; const w = first.getBoundingClientRect(); const e = second.getBoundingClientRect(); return first.classList.contains('wordmark') && second.classList.contains('home__engine') && e.top >= w.bottom - 1 && Math.abs(e.left - w.left) <= 2 && [...second.querySelectorAll('option')].map(o => o.textContent).join() === 'DuckDuckGo,Brave Search,Startpage,Ecosia,Google,Bing'; })()",
    ),
  );
  check(
    'and it shows the engine in use',
    (await ipc("document.querySelector('.home__engine-select').value")) === 'duckduckgo',
  );
  await ipc(
    "(() => { const s = document.querySelector('.home__engine-select'); s.value = 'brave'; s.dispatchEvent(new Event('change')); })()",
  );
  check(
    'choosing an engine there changes the search engine setting',
    await waitFor(() => settings.get('searchEngine') === 'brave'),
  );
  settings.reset('searchEngine');
  check(
    'and a change made elsewhere shows there',
    await waitFor(
      async () =>
        (await ipc("document.querySelector('.home__engine-select').value")) === 'duckduckgo',
    ),
  );
  const fieldWidth = async (): Promise<number> =>
    ipc<number>("document.querySelector('.wordmark__field').getBoundingClientRect().width");
  const emptyWidth = await fieldWidth();
  await ipc(
    "(() => { const i = document.querySelector('.wordmark__input'); i.value = 'a long thing to search for'; i.dispatchEvent(new Event('input')); })()",
  );
  check(
    'the field grows as text is typed in it',
    (await fieldWidth()) > emptyWidth + 100,
    `${emptyWidth} -> ${await fieldWidth()}`,
  );
  check(
    'the name of the search engine is visible: the select is as wide as the name, arrow next to it',
    await ipc(
      "(() => { const s = document.querySelector('.home__engine-select'); const w = s.getBoundingClientRect().width; return w > 40 && w < 200 && getComputedStyle(s).color !== 'rgba(0, 0, 0, 0)'; })()",
    ),
  );
  await screenshot(ui, 'ui-home');
  await ipc(
    `(() => { const i = document.querySelector('.wordmark__input'); i.value = '${SITE}/two.html'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`,
  );
  check(
    'Enter in the field goes to the address, like the address bar does',
    await waitFor(
      () => state().tabs.find((tab) => tab.id === state().activeTabId)?.url === `${SITE}/two.html`,
    ),
  );
  tabs.closeActiveTab();
  await waitFor(() => state().tabs.length === 1 && state().tabs[0]?.url === '');
  await sleep(500);
  press(Gdk.KEY_F12, 0);
  check(
    'F12 on the home page (a blank tab) opens Chrome DevTools under it, in the window',
    devtoolsPanel.isOpen(ui) && Gtk.Window.list_toplevels().length === 1,
    `windows=${Gtk.Window.list_toplevels().length}`,
  );
  await sleep(3e3);
  windowShot(context, 'window-end');
}
/**
 * WEBSWITCH_SELFTEST_BROWSERS=1: installs the real browsers (about 1.6 GB of downloads), opens a
 * page in each one inside a tab, and exercises updating, choosing a release, uninstalling and the
 * streaming choice. It needs the network and X11 mode, so it is never part of the normal run.
 */
async function browsersScenario(context: BrowserContext): Promise<void> {
  const { browsers, tabs, drm } = context;
  const state = () => tabs.getState();
  const status = (id: BrowserId) =>
    browsers.getState().browsers.find((browser) => browser.id === id);
  const page = `${SITE}/two.html`;
  check('nothing is installed at the start', browsers.getState().totalBytes === 0);
  check(
    'tabs can show other browsers (Webswitch runs on X11)',
    browsers.getState().embedding === 'ready',
    browsers.getState().embedding,
  );
  const checked = await browsers.check();
  const chromeVersions = status('chrome')?.versions ?? [];
  check(
    'checking lists the releases of every browser',
    checked.ok &&
      chromeVersions.length > 30 &&
      (status('firefox')?.versions.length ?? 0) > 30 &&
      (status('opera')?.versions.length ?? 0) > 5 &&
      (status('edge')?.versions.length ?? 0) > 5,
    (['chrome', 'firefox', 'opera', 'edge'] as const)
      .map((id) => `${id}:${String(status(id)?.versions.length)}`)
      .join(' '),
  );
  for (const id of ['firefox', 'chrome', 'opera', 'edge'] as const) {
    const result = await browsers.install(id);
    const installed = status(id)?.installed[0];
    check(
      `${id} installs (newest release), with its size on disk`,
      result.ok && installed !== void 0 && installed.sizeBytes > 1e8,
      JSON.stringify(result) + ' ' + JSON.stringify(installed),
    );
    check(
      `${id}: the download was ${id === 'chrome' ? 'not checkable (Google publishes no checksum)' : 'checked against the vendor checksum'}`,
      status(id)?.verified === (id !== 'chrome'),
      String(status(id)?.verified),
    );
  }
  const total = browsers
    .getState()
    .browsers.reduce(
      (s: number, b) => s + b.installed.reduce((t: number, r) => t + r.sizeBytes, 0),
      0,
    );
  check(
    'the total is what the installed ones take',
    browsers.getState().totalBytes === total && total > 1e9,
    String(total),
  );
  for (const id of ['firefox', 'chrome', 'opera', 'edge'] as const) {
    const spec = browsers.embedSpec(id, page);
    const before = state().tabs.length;
    const opened = spec !== null && tabs.openInBrowser(page, spec);
    check(`${id} opens the page inside a tab`, opened && state().tabs.length === before + 1);
    check(
      `${id}: the tab shows its name and the page's title`,
      await waitFor(() => {
        const title = state().tabs.find((tab) => tab.id === state().activeTabId)?.title ?? '';
        return title.startsWith(spec?.label ?? '?') && title.includes('Page Two');
      }, 6e4),
      state().tabs.find((tab) => tab.id === state().activeTabId)?.title,
    );
    tabs.closeActiveTab();
    await sleep(1500);
  }
  tabs.openPage('browsers');
  await waitFor(
    () => state().tabs.find((tab) => tab.id === state().activeTabId)?.page === 'browsers',
  );
  check(
    'the page lists every installed release with what it takes on disk',
    await waitFor(
      async () =>
        (await evaluate(context.ui, "document.querySelectorAll('.br-version').length")) === 4 &&
        String(
          await evaluate(context.ui, "document.querySelector('.br-note').textContent"),
        ).includes('GB'),
    ),
  );
  await sleep(500);
  await screenshot(context.ui, 'ui-browsers-installed');
  tabs.closeActiveTab();
  const older = (status('firefox')?.versions ?? [])[4] ?? '';
  const first = status('firefox')?.installed[0]?.version ?? '';
  check(
    'an older Firefox release installs next to the newest',
    (await browsers.install('firefox', older)).ok &&
      (status('firefox')?.installed.length ?? 0) === 2,
  );
  check(
    'and is the one in use after it is installed',
    status('firefox')?.installed.find((r) => r.active)?.version === older,
  );
  check(
    'the newest can be chosen again',
    browsers.use('firefox', first).ok &&
      status('firefox')?.installed.find((r) => r.active)?.version === first,
  );
  const before = browsers.getState().totalBytes;
  check(
    'uninstalling the old release frees its space',
    browsers.uninstall('firefox', older).ok && browsers.getState().totalBytes < before,
  );
  check(
    'a release number that is not one is refused',
    !(await browsers.install('firefox', '../evil')).ok &&
      !browsers.uninstall('firefox', '../..').ok,
  );
  check('Opera cannot be chosen for streaming (no Widevine)', !browsers.setStreaming('opera').ok);
  check(
    'Chrome installed here can be',
    browsers.setStreaming('chrome').ok &&
      (drm.findBrowser()?.path ?? '').includes('/browsers/chrome/'),
  );
  check(
    'and the system one is back on request',
    browsers.setStreaming('system').ok && !(drm.findBrowser()?.path ?? '').includes('/browsers/'),
  );
  for (const id of ['edge', 'opera', 'chrome', 'firefox'] as const)
    for (const release of status(id)?.installed ?? []) browsers.uninstall(id, release.version);
  check('everything can be uninstalled', browsers.getState().totalBytes === 0);
}
/**
 * WEBSWITCH_SELFTEST_URL=https://...: opens that page in a tab, waits, and reports whether the page
 * view shows content or is blank (how many colors it has), with a screenshot. For chasing a page
 * that renders wrong in Webswitch but not in a bare WebView; it goes to the network, so it is opt-in.
 */
async function pageProbe(context: BrowserContext, url: string): Promise<void> {
  const { tabs } = context;
  // WEBSWITCH_SELFTEST_SEED_GOOGLE_COOKIES=1: seed cookies with the names a real signed-in Google
  // account would have (fake values; nobody is actually signed in anywhere) before navigating, to
  // check whether merely their PRESENCE — not real auth — changes how a page like youtube.com loads
  // (the user suspects the empty-feed-on-first-load bug only happens signed in).
  if (GLib.getenv('WEBSWITCH_SELFTEST_SEED_GOOGLE_COOKIES') === '1') {
    const seed = async (name: string, domain: string, secure = false): Promise<void> => {
      const cookie = new Soup.Cookie(name, 'fake-value', domain, '/', 3600 * 24 * 30);
      cookie.set_secure(secure);
      await context.session.get_cookie_manager().add_cookie(cookie, null);
    };
    for (const name of ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID'])
      await seed(name, '.google.com');
    for (const name of [
      '__Secure-1PSID',
      '__Secure-3PSID',
      '__Secure-1PAPISID',
      '__Secure-3PAPISID',
    ])
      await seed(name, '.google.com', true);
    for (const name of ['LOGIN_INFO', 'PREF', 'VISITOR_INFO1_LIVE', 'YSC'])
      await seed(name, '.youtube.com');
    console.log('seeded cookies as if signed in to Google (fake values)');
  }
  const id = tabs.createTab(url);
  await waitFor(() => tabs.getState().activeTabId === id);
  for (const seconds of [6, 12, 20]) {
    await sleep((seconds - (seconds === 6 ? 0 : seconds === 12 ? 6 : 12)) * 1e3);
    const view = tabs.getActiveView();
    if (!view) continue;
    const texture = await view.get_snapshot(
      WebKit.SnapshotRegion.VISIBLE,
      WebKit.SnapshotOptions.NONE,
      null,
    );
    const downloader = new Gdk.TextureDownloader(texture);
    downloader.set_format(Gdk.MemoryFormat.R8G8B8A8);
    const [bytes, stride] = downloader.download_bytes();
    const pixels = bytes.toArray();
    const colors = /* @__PURE__ */ new Set();
    for (let y = 0; y < texture.get_height(); y += 9)
      for (let x = 0; x < texture.get_width(); x += 9) {
        const at = y * stride + x * 4;
        colors.add(
          ((pixels[at] ?? 0) << 16) | ((pixels[at + 1] ?? 0) << 8) | (pixels[at + 2] ?? 0),
        );
      }
    texture.save_to_png(`${OUT}/page-probe-${String(seconds)}.png`);
    console.log(
      `PROBE t=${seconds}s title="${view.get_title() ?? ''}" loading=${view.is_loading} colors=${colors.size} ${colors.size < 6 ? 'BLANK' : 'content'} state=${JSON.stringify(tabs.getState().tabs.find((tab: { id: number }) => tab.id === id))}`,
    );
  }
}
/**
 * WEBSWITCH_SELFTEST_BROWSERS=fit: opens a page in every browser that is installed (nothing is
 * downloaded), and reports where its window sits against the tab's area, with a screenshot of the
 * whole Webswitch window. For chasing embedded windows that do not fit their tab.
 */
async function fitScenario(context: BrowserContext): Promise<void> {
  const { browsers, tabs, main } = context;
  for (const id of ['firefox', 'chrome', 'opera', 'edge'] as const) {
    const spec = browsers.embedSpec(id, `${SITE}/two.html`);
    if (spec === null) {
      console.log(`FIT ${id}: not installed`);
      continue;
    }
    tabs.openInBrowser(`${SITE}/two.html`, spec);
    await sleep(6e3);
    const area = main.stack;
    const [, bounds] = area.compute_bounds(main.window);
    console.log(
      `FIT ${id}: tab area ${Math.round(bounds.get_x())} ${Math.round(bounds.get_y())} ${area.get_width()} ${area.get_height()} | ${await tabs.probeEmbed('geometry')}`,
    );
    console.log(`FIT ${id}: ${await tabs.probeEmbed(`shotparent ${OUT}/fit-${id}.png`)}`);
    tabs.closeActiveTab();
    await sleep(2500);
  }
}
async function extensionsScenario(context: BrowserContext): Promise<void> {
  const { extensions, extensionRuntime, tabs, settings } = context;
  const fixture = (name: string) =>
    GLib.build_filenamev([GLib.get_current_dir(), 'tests/extensions', name]);
  const open = async (url: string) => {
    const id = tabs.createTab(url);
    const view = tabs.viewOfTab(id);
    if (!view) throw new Error('no view');
    await waitFor(() => !view.is_loading && (view.get_uri() ?? '').startsWith('http'));
    return view;
  };
  const dataset = (view: WebKit.WebView, key: string) =>
    evaluate(view, `document.documentElement.dataset.${key} ?? null`);
  const site = `${SITE}/index.html`;
  // Pure, offline: whether a URL is one extension's own page on the real Chrome Web Store, the
  // one thing that decides whether the toolbar's "Install in Webswitch" button can appear.
  check(
    'webStoreDetailId reads the id off a real store detail address',
    webStoreDetailId(
      'https://chromewebstore.google.com/detail/some-name/ddkjiahejlhfcafbddmgiahcphecmpfh',
    ) === 'ddkjiahejlhfcafbddmgiahcphecmpfh',
  );
  check(
    'and off the older chrome.google.com/webstore address',
    webStoreDetailId(
      'https://chrome.google.com/webstore/detail/some-name/ddkjiahejlhfcafbddmgiahcphecmpfh',
    ) === 'ddkjiahejlhfcafbddmgiahcphecmpfh',
  );
  check(
    "but not the store's own search or home page",
    webStoreDetailId('https://chromewebstore.google.com/') === null &&
      webStoreDetailId('https://chromewebstore.google.com/category/extensions') === null,
  );
  check(
    'and not an unrelated page that happens to have an id-shaped word in its address',
    webStoreDetailId('https://example.com/detail/x/ddkjiahejlhfcafbddmgiahcphecmpfh') === null,
  );
  check('extensions are off by default', !extensions.getState().enabled);
  tabs.openPage('extensions');
  await sleep(1500);
  await screenshot(context.ui, 'extensions-off');
  check(
    'the page explains the risk and offers only the switch',
    (await evaluate(
      context.ui,
      "!!document.querySelector('.ex-gate') && !document.querySelector('.ex-input') && document.querySelector('.ex-gate').textContent.includes('may track me')",
    )) === true,
  );
  const refused = await extensions.prepareFromFolder(fixture('hello'));
  check('installing is refused while they are off', !refused.ok, JSON.stringify(refused));
  check(
    'no extension script runs while they are off',
    (await dataset(await open(site), 'hello')) === null,
  );
  check('the switch turns on', settings.set('extensions', true).ok);
  check('the state follows the switch', extensions.getState().enabled);
  const prepared = await extensions.prepareFromFolder(fixture('hello'));
  if (prepared.ok) {
    const hosts = GLib.build_filenamev([
      GLib.get_user_config_dir(),
      'webswitch',
      'NativeMessagingHosts',
    ]);
    GLib.mkdir_with_parents(hosts, 493);
    GLib.file_set_contents(
      GLib.build_filenamev([hosts, 'dev.webswitch.test.json']),
      JSON.stringify({
        name: 'dev.webswitch.test',
        description: 'Self-test host',
        path: fixture('native-host.py'),
        type: 'stdio',
        allowed_origins: [`chrome-extension://${prepared.id}/`],
      }),
    );
  }
  const pending = extensions.getState().pending;
  check(
    'the fixture waits for confirmation',
    prepared.ok && pending !== null,
    JSON.stringify(prepared),
  );
  check(
    'its name is translated from _locales',
    pending?.name === 'Hello fixture',
    pending?.name ?? '',
  );
  check(
    'it is summarized: some sites, popup, options, background',
    pending?.hostAccess === 'sites' &&
      pending.hasPopup &&
      pending.hasOptions &&
      pending.hasBackground &&
      pending.supported.includes('storage'),
    JSON.stringify(pending),
  );
  check(
    'nothing is installed before the user confirms',
    extensions.getState().extensions.length === 0,
  );
  tabs.openPage('extensions');
  await sleep(2500);
  await screenshot(context.ui, 'extensions-pending');
  const confirmed = await extensions.confirm();
  check('confirming installs it', confirmed.ok && extensions.getState().extensions.length === 1);
  const id = confirmed.ok ? confirmed.id : '';
  await sleep(1500);
  const view = await open(site);
  check(
    'the content script runs',
    await waitFor(async () => (await dataset(view, 'hello')) === 'yes'),
  );
  check(
    'a message to the background page is answered (with the sender tab)',
    await waitFor(async () => /"pong":42,"tab":\d+/.test(String(await dataset(view, 'reply')))),
    String(await dataset(view, 'reply')),
  );
  check(
    'the background page keeps what it stored',
    await waitFor(async () => (await dataset(view, 'stored')) === 'ran'),
    String(await dataset(view, 'stored')),
  );
  check(
    'the background page can fetch a host it declared',
    await waitFor(async () => /"length":\d{3,}/.test(String(await dataset(view, 'fetched')))),
    String(await dataset(view, 'fetched')),
  );
  const outline = await evaluate(
    view,
    "getComputedStyle(document.querySelector('h1')).outlineColor + ' ' + getComputedStyle(document.querySelector('h1')).outlineStyle",
  );
  check('the content style applies', outline === 'rgb(1, 2, 3) solid', String(outline));
  const contentCss = await evaluate(
    view,
    `(() => { const s = [...document.querySelectorAll('style')].find((el) => el.textContent.includes('ws-content-css-test')); return s ? s.textContent : null; })()`,
  );
  check(
    "content_scripts' own css resolves __MSG_@@extension_id__ and a relative url() against the" +
      ' extension, and leaves a fragment-only url(#id) alone (2026-09-29 fix)',
    typeof contentCss === 'string' &&
      contentCss.includes(`url(webswitch-ext://${id}/fake-font.ttf)`) &&
      contentCss.includes('url(#ws-fragment-only)'),
    String(contentCss),
  );
  check(
    'the page itself cannot see the extension API',
    (await evaluate(
      view,
      "typeof chrome === 'undefined' || typeof chrome.runtime === 'undefined'",
    )) === true,
  );
  await extensionRuntime.openPopup(id, {
    x: 900,
    y: 30,
    width: 30,
    height: 30,
  });
  check(
    'the popup runs and its storage change reaches the content script',
    await waitFor(async () => (await dataset(view, 'popup')) === 'opened'),
  );
  check(
    'the popup can message the content script in the active tab',
    await waitFor(async () => (await dataset(view, 'popupTitle')) === 'Local Test Page'),
    String(await dataset(view, 'popupTitle')),
  );
  extensionRuntime.openOptions(id);
  check(
    'the options page runs',
    await waitFor(async () => (await dataset(view, 'options')) === 'opened'),
  );
  check(
    'the extension shows no files to a page that did not get them',
    (await evaluate(
      view,
      `fetch('webswitch-ext://${id}/bg.js').then(() => 'loaded', () => 'refused')`,
    )) === 'refused',
  );
  tabs.openPage('extensions');
  await sleep(800);
  await screenshot(context.ui, 'extensions-installed');
  tabs.activateTab(tabs.idOfView(view) ?? 0);
  const backgroundState = async () => {
    const raw = await extensionRuntime.evaluateInBackground(id, 'JSON.stringify(state)');
    return JSON.parse(raw) as {
      installed?: string;
      registered?: number;
      dnr?: number;
      alarms?: number;
      requests?: number;
      command?: string;
      menu?: string;
      navigated?: string;
      native?: unknown;
      nativeError?: unknown;
      nativePort?: unknown;
      nativeMissing?: unknown;
      auth?: number;
      userMessage?: unknown;
      proxy?: string;
      cancelled?: number;
      offscreen?: unknown;
      contexts?: unknown;
      language?: string;
      cookieChanged?: number;
      visited?: number;
      tabTitle?: string;
      downloadState?: string;
      downloads?: number;
      cleaned?: boolean;
      closed?: number;
      ownPage?: string;
      ownPageTabId?: number;
      crossReply?: string;
      crossPortReply?: string;
      mhtmlType?: string;
      mhtmlLength?: number;
      mhtmlLooksRight?: boolean;
      insertCssUrls?: string;
      insertCssSurvivedWipe?: boolean;
    };
  };
  check(
    'a port to the background page is answered',
    await waitFor(async () => String(await dataset(view, 'port')).includes('"echo":{"hi":1}')),
    String(await dataset(view, 'port')),
  );
  check(
    'chrome.cookies sets and lists a cookie (with the cookies permission)',
    await waitFor(async () => /"count":[1-9]/.test(String(await dataset(view, 'cookie')))),
    String(await dataset(view, 'cookie')),
  );
  const seen = await backgroundState();
  check(
    'runtime.onInstalled fired with the reason install',
    seen.installed === 'install',
    String(seen.installed),
  );
  check(
    'registerContentScripts and dynamic rules were accepted',
    seen.registered === 1 && seen.dnr === 1,
    JSON.stringify(seen),
  );
  check(
    'an alarm asked for with "when" is kept, not fired at once',
    seen.alarms === 1,
    String(seen.alarms),
  );
  check(
    'webRequest tells what the page loaded',
    await waitFor(async () => Number((await backgroundState()).requests) > 0),
  );
  check(
    'a shortcut an extension asked for reaches its onCommand',
    context.shortcuts.trigger('Ctrl+Shift+Y') &&
      (await waitFor(async () => (await backgroundState()).command === 'ping-command')),
  );
  const menu = WebKit.ContextMenu.new();
  extensionRuntime.populateMenu(view, menu, {
    link: false,
    image: false,
    media: false,
    editable: false,
    selection: false,
    linkUrl: '',
    srcUrl: '',
  });
  const menuAction = menu
    .get_items()
    .map((item) => item.get_gaction())
    .find((action) => action !== null);
  check('the extension adds an item to the page menu', menuAction !== void 0);
  menuAction?.activate(null);
  check(
    'choosing it reaches onClicked with the page address',
    await waitFor(async () =>
      String((await backgroundState()).menu).startsWith('fixture-item on http'),
    ),
    String((await backgroundState()).menu),
  );
  tabs.reloadTab(tabs.idOfView(view) ?? 0);
  await waitFor(() => !view.is_loading);
  check(
    'webNavigation.onCompleted reported the page',
    await waitFor(async () => String((await backgroundState()).navigated).startsWith('http')),
  );
  check(
    'a content script registered while running is injected',
    await waitFor(async () => (await dataset(view, 'dynamic')) === 'yes'),
  );
  const dynamic = await open(`${SITE}/blockme2.html`);
  await sleep(1500);
  dynamic.reload();
  await waitFor(() => !dynamic.is_loading);
  await sleep(500);
  check(
    'a rule added while running blocks the script',
    (await evaluate(dynamic, 'window.blocked2Ran === true')) === false,
  );
  tabs.activateTab(tabs.idOfView(view) ?? 0);
  check(
    'native messaging: a program that names the extension answers',
    await waitFor(async () =>
      JSON.stringify((await backgroundState()).native).includes('"hi":"native"'),
    ),
    JSON.stringify((await backgroundState()).native ?? (await backgroundState()).nativeError),
  );
  check(
    'and a port to it passes messages both ways (it is started with the extension address)',
    await waitFor(async () =>
      JSON.stringify((await backgroundState()).nativePort).includes(`chrome-extension://${id}/`),
    ),
    JSON.stringify((await backgroundState()).nativePort),
  );
  check(
    'a program nobody announced is not started',
    String((await backgroundState()).nativeMissing).includes('not found'),
    String((await backgroundState()).nativeMissing),
  );
  const secret = await open(`${SITE}/secret.html`);
  check(
    'an extension that keeps logins answers a site asking for a username and password',
    (await waitFor(() => secret.title === 'Secret')) &&
      Number((await backgroundState()).auth) === 1,
    `${secret.title} / ${String((await backgroundState()).auth)}`,
  );
  tabs.activateTab(tabs.idOfView(view) ?? 0);
  check(
    'a user script from chrome.userScripts runs (in its own world) and can message the extension',
    (await waitFor(async () => (await dataset(view, 'us')) === 'yes')) &&
      (await waitFor(async () => String(await dataset(view, 'usReply')).includes('"ok":true'))) &&
      JSON.stringify((await backgroundState()).userMessage).includes('user'),
    JSON.stringify((await backgroundState()).userMessage),
  );
  await extensionRuntime.evaluateInBackground(id, 'setProxy(); 0');
  check(
    'chrome.proxy sets a proxy for the pages and the browser says so',
    (await waitFor(async () => (await backgroundState()).proxy === 'set')) &&
      extensions.getState().proxy?.extension === id,
    String((await backgroundState()).proxy),
  );
  const proxied = await open('http://proxied.test:8080/some/page');
  check(
    'a page that is not on this machine goes through the proxy',
    proxied.title === 'via proxy',
    proxied.title,
  );
  extensionRuntime.clearProxy();
  check(
    'stopping it (the button on the page) puts the system settings back',
    extensions.getState().proxy === null,
  );
  await extensionRuntime.evaluateInBackground(id, 'setProxy(); 0');
  await waitFor(() => extensions.getState().proxy !== null);
  await extensionRuntime.evaluateInBackground(id, 'clearProxy(); 0');
  check(
    'the extension can let go of it too',
    await waitFor(() => extensions.getState().proxy === null),
  );
  const cancelled = tabs.createTab(`${SITE}/cancel-me.html`);
  await sleep(1500);
  check(
    'a blocking webRequest listener stops a page from loading',
    Number((await backgroundState()).cancelled) >= 1 &&
      (tabs.viewOfTab(cancelled)?.title ?? '') !== 'Error response',
    `${String((await backgroundState()).cancelled)} / title ${JSON.stringify(tabs.viewOfTab(cancelled)?.title)} / uri ${String(tabs.viewOfTab(cancelled)?.get_uri())}`,
  );
  const redirected = tabs.createTab(`${SITE}/redirect-me.html`);
  const redirectedView = tabs.viewOfTab(redirected);
  check(
    'a declarativeNetRequest redirect rule sends a page elsewhere before it is asked for',
    await waitFor(() => redirectedView?.title === 'Page Two'),
    redirectedView?.title ?? '',
  );
  tabs.activateTab(tabs.idOfView(view) ?? 0);
  await extensionRuntime.evaluateInBackground(id, 'openOwnPage(); 0');
  await waitFor(async () => (await backgroundState()).ownPageTabId !== undefined);
  const ownTabId = (await backgroundState()).ownPageTabId ?? -1;
  const ownView = tabs.viewOfTab(ownTabId);
  check(
    "tabs.create to one of the extension's own pages (not in web_accessible_resources) loads it",
    ownView !== null &&
      (await waitFor(async () => (await dataset(ownView, 'ownPage')) === 'yes')) &&
      (await waitFor(async () => (await backgroundState()).ownPage === 'loaded')),
    JSON.stringify({
      ownTabId,
      uri: ownView?.get_uri() ?? null,
      state: (await backgroundState()).ownPage,
    }),
  );
  tabs.closeTab(ownTabId);
  tabs.activateTab(tabs.idOfView(view) ?? 0);
  // Cross-extension messaging (chrome.runtime.sendMessage/.connect(targetId, ...),
  // runtime.onMessageExternal/onConnectExternal): a second extension, `peer`, whose manifest
  // names `hello`'s real id (only known now that hello is installed) in
  // externally_connectable.ids — patched into a temp copy, since the checked-in fixture only
  // carries a placeholder (no fixture can hard-code an id that depends on where it is checked out).
  const peerSrc = fixture('peer');
  const peerDir = GLib.dir_make_tmp('ws-peer-XXXXXX');
  const [, peerManifestBytes] = GLib.file_get_contents(
    GLib.build_filenamev([peerSrc, 'manifest.json']),
  );
  GLib.file_set_contents(
    GLib.build_filenamev([peerDir, 'manifest.json']),
    new TextDecoder().decode(peerManifestBytes).replace('__HELLO_ID__', id),
  );
  const [, peerBgBytes] = GLib.file_get_contents(GLib.build_filenamev([peerSrc, 'bg.js']));
  GLib.file_set_contents(GLib.build_filenamev([peerDir, 'bg.js']), peerBgBytes);
  const preparedPeer = await extensions.prepareFromFolder(peerDir);
  const confirmedPeer = preparedPeer.ok
    ? await extensions.confirm()
    : { ok: false as const, error: 'peer fixture was refused' };
  check(
    'the peer fixture (externally_connectable) installs',
    confirmedPeer.ok,
    JSON.stringify(preparedPeer),
  );
  const peerId = confirmedPeer.ok ? confirmedPeer.id : '';
  const peerState = async () => {
    const raw = await extensionRuntime.evaluateInBackground(peerId, 'JSON.stringify(state)');
    return JSON.parse(raw) as {
      messages?: { message: unknown; senderId: string }[];
      ports?: (string | null)[];
      portMessages?: unknown[];
      helloReply?: string;
    };
  };
  await extensionRuntime.evaluateInBackground(id, `messageExternal(${JSON.stringify(peerId)}); 0`);
  check(
    'chrome.runtime.sendMessage(targetId, ...) reaches the target and its onMessageExternal answers',
    await waitFor(async () => String((await backgroundState()).crossReply).includes('"ok":true')),
    String((await backgroundState()).crossReply),
  );
  check(
    "the target's sender.id in onMessageExternal names the calling extension",
    await waitFor(async () =>
      ((await peerState()).messages ?? []).some((entry) => entry.senderId === id),
    ),
    JSON.stringify(await peerState()),
  );
  await extensionRuntime.evaluateInBackground(id, `connectExternal(${JSON.stringify(peerId)}); 0`);
  check(
    'chrome.runtime.connect(targetId, ...) reaches the target, whose onConnectExternal answers on the port',
    await waitFor(async () =>
      String((await backgroundState()).crossPortReply).includes('"echo":{"hi":1}'),
    ),
    String((await backgroundState()).crossPortReply),
  );
  await extensionRuntime.evaluateInBackground(peerId, `tryMessageHello(${JSON.stringify(id)}); 0`);
  check(
    'a target that never declared externally_connectable refuses a message from another extension',
    await waitFor(async () => (await peerState()).helloReply === 'undefined'),
    String((await peerState()).helloReply),
  );
  // Done with it: removed now, like the blocker fixture is removed after its own checks, so the
  // extension count later in this scenario ("removing works") only has to account for `hello`.
  if (confirmedPeer.ok) extensions.remove(confirmedPeer.id);
  await extensionRuntime.evaluateInBackground(id, 'captureMhtml(); 0');
  check(
    "chrome.pageCapture.saveAsMHTML saves the tab's page with WebKit's own MHTML writer",
    await waitFor(async () => (await backgroundState()).mhtmlLooksRight === true),
    JSON.stringify({
      type: (await backgroundState()).mhtmlType,
      length: (await backgroundState()).mhtmlLength,
    }),
  );
  await extensionRuntime.evaluateInBackground(
    id,
    `insertCssFile(${JSON.stringify(tabs.idOfView(view))}); 0`,
  );
  check(
    'chrome.scripting.insertCSS({files}) resolves a root-relative url() against the extension' +
      ", not the page (2026-09-29 fix), and leaves a fragment-only url(#id) (an SVG filter's own" +
      ' reference into the page) alone',
    await waitFor(async () => {
      const css = (await backgroundState()).insertCssUrls;
      return (
        typeof css === 'string' &&
        css.includes(`url(webswitch-ext://${id}/fonts/fake.ttf)`) &&
        css.includes('url(#ws-fragment-only)')
      );
    }),
    String((await backgroundState()).insertCssUrls),
  );
  await extensionRuntime.evaluateInBackground(
    id,
    `insertCssSurvivesWipe(${JSON.stringify(tabs.idOfView(view))}); 0`,
  );
  check(
    'chrome.scripting.insertCSS survives the injected page later replacing' +
      ' document.documentElement.innerHTML wholesale (2026-09-29 fix, a real bug: Mobile' +
      " Simulator's own startup script does exactly this to its own page right after inserting" +
      ' its styles, silently losing them every time before the fix)',
    await waitFor(async () => (await backgroundState()).insertCssSurvivedWipe === true),
    String((await backgroundState()).insertCssSurvivedWipe),
  );
  check(
    'an offscreen document is made, answers the background page, and is listed as a context',
    (await waitFor(async () =>
      JSON.stringify((await backgroundState()).offscreen).includes('offscreen'),
    )) && JSON.stringify((await backgroundState()).contexts).includes('OFFSCREEN_DOCUMENT'),
    JSON.stringify([(await backgroundState()).offscreen, (await backgroundState()).contexts]),
  );
  check(
    'chrome.i18n knows the language of the user',
    typeof (await backgroundState()).language === 'string' &&
      String((await backgroundState()).language).length >= 2,
    String((await backgroundState()).language),
  );
  check(
    'cookie changes and visited pages are told to the extension that listens',
    (await waitFor(async () => Number((await backgroundState()).cookieChanged) >= 1)) &&
      (await waitFor(async () => Number((await backgroundState()).visited) >= 1)),
    JSON.stringify([(await backgroundState()).cookieChanged, (await backgroundState()).visited]),
  );
  check(
    'a page title change reaches tabs.onUpdated',
    await waitFor(async () => typeof (await backgroundState()).tabTitle === 'string'),
    String((await backgroundState()).tabTitle),
  );
  settings.set('downloadFolder', OUT);
  await extensionRuntime.evaluateInBackground(id, 'startDownload(); 0');
  check(
    'chrome.downloads starts a download, follows it to its end and lists it',
    (await waitFor(async () => (await backgroundState()).downloadState === 'complete', 15e3)) &&
      (await waitFor(async () => Number((await backgroundState()).downloads) >= 1)),
    JSON.stringify([(await backgroundState()).downloadState, (await backgroundState()).downloads]),
  );
  await extensionRuntime.evaluateInBackground(id, 'clean(); 0');
  check(
    'chrome.browsingData clears what it is asked to',
    await waitFor(async () => (await backgroundState()).cleaned === true),
  );
  tabs.closeTab(tabs.createTab(`${SITE}/two.html`));
  await sleep(600);
  await extensionRuntime.evaluateInBackground(id, 'askClosed(); 0');
  check(
    'chrome.sessions lists the tabs closed recently',
    await waitFor(async () => Number((await backgroundState()).closed) >= 1),
    String((await backgroundState()).closed),
  );
  await extensions.setEnabled(id, false);
  await sleep(500);
  tabs.reloadTab(tabs.idOfView(view) ?? 0);
  await waitFor(() => !view.is_loading);
  await sleep(500);
  check('a turned off extension does not run', (await dataset(view, 'hello')) === null);
  await extensions.setEnabled(id, true);
  const before = await open(`${SITE}/blockme.html`);
  check(
    'the script loads without the blocker',
    (await evaluate(before, 'window.blockedRan === true')) === true,
  );
  await extensions.prepareFromFolder(fixture('blocker'));
  const blockerSummary = extensions.getState().pending;
  check('the blocker is summarized as all sites', blockerSummary?.hostAccess === 'all');
  const blocker = await extensions.confirm();
  await sleep(2500);
  before.reload();
  await waitFor(() => !before.is_loading);
  await sleep(500);
  check(
    'the rule blocks the script',
    (await evaluate(before, 'window.blockedRan === true')) === false,
  );
  if (blocker.ok) await extensions.setEnabled(blocker.id, false);
  await sleep(1e3);
  before.reload();
  await waitFor(() => !before.is_loading);
  await sleep(500);
  check(
    'turned off, the rule stops blocking',
    (await evaluate(before, 'window.blockedRan === true')) === true,
  );
  settings.set('extensions', false);
  check('with the switch off no extension is active', extensions.active().length === 0);
  settings.set('extensions', true);
  check(
    'removing works',
    (blocker.ok ? extensions.remove(blocker.id) : { ok: false }).ok &&
      extensions.getState().extensions.length === 1,
  );
  check(
    'a bad address is refused before any request',
    !(await extensions.prepareFromStore('https://example.com/not-the-store')).ok,
  );
  check(
    'a scheme page cannot be loaded by a tab',
    await (async () => {
      const attempt = await open(site);
      attempt.load_uri(`webswitch-ext://${id}/popup.html`);
      await sleep(1e3);
      return !(attempt.get_uri() ?? '').startsWith('webswitch-ext:');
    })(),
  );
}
/** Opt-in, and it asks Google: installs one real extension from the Chrome Web Store and looks at it. */
async function storeScenario(context: BrowserContext): Promise<void> {
  const { extensions, settings, tabs, ui } = context;
  settings.set('extensions', true);
  const wanted = GLib.getenv('WEBSWITCH_SELFTEST_STORE_ID') ?? 'ddkjiahejlhfcafbddmgiahcphecmpfh';

  // The Extensions page's "Search the Chrome Web Store" button, through the real UI -> IPC path.
  await waitFor(() => !ui.is_loading && (ui.get_uri() ?? '').startsWith('webswitch://ui/'));
  await sleep(1200);
  const before = new Set(tabs.getState().tabs.map((tab) => tab.id));
  await evaluate(ui, 'window.browserApi.extensions.openStore()');
  await sleep(500);
  const storeTabId = tabs.getState().tabs.find((tab) => !before.has(tab.id))?.id ?? -1;
  const storeView = tabs.viewOfTab(storeTabId);
  check(
    'the Search the Chrome Web Store button opens a tab at the real store',
    storeView !== null &&
      (await waitFor(() =>
        (storeView?.get_uri() ?? '').startsWith('https://chromewebstore.google.com/'),
      )),
    String(storeView?.get_uri()),
  );
  // A real extension's own page on the store: the toolbar's install button should be able to find
  // it (Tab.storeId), the same way it would for whatever the user actually browsed to.
  tabs.loadUrl(storeTabId, `https://chromewebstore.google.com/detail/x/${wanted}`);
  await waitFor(() => !(tabs.viewOfTab(storeTabId)?.is_loading ?? true));
  await sleep(1500);
  const detailState = tabs.getState().tabs.find((tab) => tab.id === storeTabId);
  check(
    "a real extension's own page on the store sets Tab.storeId, so the install button can appear",
    detailState?.storeId === wanted,
    JSON.stringify(detailState?.storeId),
  );
  tabs.closeTab(storeTabId);

  const result = await extensions.prepareFromStore(
    `https://chromewebstore.google.com/detail/x/${wanted}`,
  );
  const pending = extensions.getState().pending;
  check(
    'a Web Store extension downloads and is checked',
    result.ok && pending !== null,
    JSON.stringify(result),
  );
  console.log(`store: ${JSON.stringify(pending)}`);
  if (result.ok) {
    check('and installs', (await extensions.confirm()).ok);
    if (GLib.getenv('WEBSWITCH_SELFTEST_STORE_POPUP') === 'fetch') {
      await sleep(3e3);
      await context.extensionRuntime.evaluateInBackground(
        wanted,
        `fetch('https://identity.bitwarden.com/accounts/prelogin/password', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json', 'Bitwarden-Client-Name': 'browser', 'Bitwarden-Client-Version': '2026.9.2', 'Bitwarden-Package-Type': 'Safari Extension', 'Device-Type': '20', 'Device-Identifier': '997c9703-79b7-4fdf-865c-0aaaf7eadc92' }, body: JSON.stringify({ email: 'nobody@example.invalid' }) }).then(async (r) => { self.__probe = JSON.stringify({ status: r.status, type: r.headers.get('content-type'), text: await r.text() }); }, (e) => { self.__probe = 'ERR ' + e; }); 0`,
      );
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        const got = await context.extensionRuntime.evaluateInBackground(
          wanted,
          'String(self.__probe)',
        );
        if (got !== 'undefined') {
          console.log(`fetch probe: ${got}`);
          break;
        }
      }
    }
    if (GLib.getenv('WEBSWITCH_SELFTEST_STORE_POPUP') === 'login') {
      tabs.createTab(`${SITE}/index.html`);
      await sleep(3e3);
      await context.extensionRuntime.openPopup(wanted, {
        x: 900,
        y: 30,
        width: 30,
        height: 30,
      });
      await sleep(6e3);
      const popup = context.extensionRuntime.popupView();
      if (popup) {
        const click = (label: string) =>
          evaluate(
            popup,
            `(() => { const b = [...document.querySelectorAll('button, a')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (b) b.click(); return !!b; })()`,
          );
        const fill = (selector: string, value: string) =>
          evaluate(
            popup,
            `(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (!i) return false; i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
          );
        console.log(`login: click Log in -> ${String(await click('Log in'))}`);
        await sleep(2e3);
        console.log(
          `login: email -> ${String(await fill('input[type=email], input[formcontrolname=email]', 'nobody@example.invalid'))}`,
        );
        await sleep(500);
        console.log(`login: continue -> ${String(await click('Continue'))}`);
        await sleep(2500);
        console.log(
          `login: password -> ${String(await fill('input[type=password]', 'not-a-real-password-1'))}`,
        );
        await sleep(500);
        console.log(
          `login: submit -> ${String(await evaluate(popup, "(() => { const b = document.querySelector('button[type=submit]'); if (b) b.click(); return !!b; })()"))}`,
        );
        await sleep(7e3);
        console.log(
          `login text: ${JSON.stringify(await evaluate(popup, 'document.body.innerText.slice(0, 500)'))}`,
        );
        await screenshot(popup, 'extension-login');
      }
    }
    if (GLib.getenv('WEBSWITCH_SELFTEST_STORE_POPUP') === 'ghostery') {
      const ghostery = await extensions.prepareFromStore('mlomiejdfkolichcflejclcbmpeaniij');
      const ghosteryConfirm = ghostery.ok ? await extensions.confirm() : null;
      console.log(
        `ghostery installed: ${JSON.stringify(ghostery)} confirm: ${JSON.stringify(ghosteryConfirm)} active: ${JSON.stringify(extensions.getState().extensions.map((item: { id: string; enabled: boolean }) => [item.id, item.enabled]))}`,
      );
      for (let round = 1; round <= 2; round++) {
        const started = GLib.get_monotonic_time();
        tabs.createTab('https://www.google.com/search?q=webswitch+browser+test');
        const view = tabs.getActiveView();
        await waitFor(() => !!view && !view.is_loading, 3e4);
        const seconds = (GLib.get_monotonic_time() - started) / 1e6;
        console.log(
          `ghostery round ${String(round)}: ${seconds.toFixed(1)}s, title=${JSON.stringify(view?.get_title())}`,
        );
        tabs.closeActiveTab();
        await sleep(1e3);
      }
    }
    if (GLib.getenv('WEBSWITCH_SELFTEST_STORE_POPUP') === 'youtube') {
      if (GLib.getenv('WEBSWITCH_SELFTEST_YT_NO_GHOSTERY') !== '1') {
        const ghostery = await extensions.prepareFromStore('mlomiejdfkolichcflejclcbmpeaniij');
        const ghosteryConfirm = ghostery.ok ? await extensions.confirm() : null;
        console.log(
          `ghostery installed: ${JSON.stringify(ghostery)} confirm: ${JSON.stringify(ghosteryConfirm)}`,
        );
      }
      const colorsOf = async (v: WebKit.WebView): Promise<number> => {
        const texture = await v.get_snapshot(
          WebKit.SnapshotRegion.VISIBLE,
          WebKit.SnapshotOptions.NONE,
          null,
        );
        const downloader = new Gdk.TextureDownloader(texture);
        downloader.set_format(Gdk.MemoryFormat.R8G8B8A8);
        const [bytes, stride] = downloader.download_bytes();
        const pixels = bytes.toArray();
        const colors = new Set<number>();
        for (let y = 0; y < texture.get_height(); y += 9)
          for (let x = 0; x < texture.get_width(); x += 9) {
            const at = y * stride + x * 4;
            colors.add(
              ((pixels[at] ?? 0) << 16) | ((pixels[at + 1] ?? 0) << 8) | (pixels[at + 2] ?? 0),
            );
          }
        return colors.size;
      };
      tabs.createTab('https://www.youtube.com/');
      const view = tabs.getActiveView();
      await waitFor(() => !!view && !view.is_loading, 3e4);
      if (view) {
        let elapsed = 0;
        for (const seconds of [4, 8, 12, 20, 30]) {
          await sleep((seconds - elapsed) * 1e3);
          elapsed = seconds;
          console.log(
            `youtube first load +${String(seconds)}s: colors=${String(await colorsOf(view))} title=${JSON.stringify(view.get_title())}`,
          );
        }
        await screenshot(view, 'youtube-first');
        view.reload();
        await waitFor(() => !view.is_loading, 3e4);
        await sleep(4e3);
        console.log(
          `youtube after reload: colors=${String(await colorsOf(view))} title=${JSON.stringify(view.get_title())}`,
        );
        await screenshot(view, 'youtube-reload');
      }
    }
    if (GLib.getenv('WEBSWITCH_SELFTEST_STORE_POPUP') === 'idle')
      for (let second = 1; second <= 4; second++) {
        await sleep(1e3);
        const started = GLib.get_monotonic_time();
        const answer = await Promise.race([
          context.extensionRuntime.evaluateInBackground(wanted, 'String(1 + 1)'),
          sleep(3e3).then(() => 'TIMEOUT'),
        ]);
        console.log(
          `background at ${second}s: ${answer} (${Math.round((GLib.get_monotonic_time() - started) / 1e3)} ms)`,
        );
      }
    if (GLib.getenv('WEBSWITCH_SELFTEST_STORE_POPUP') === '1') {
      tabs.createTab(`${SITE}/index.html`);
      await sleep(4e3);
      await context.extensionRuntime.openPopup(wanted, {
        x: 900,
        y: 30,
        width: 30,
        height: 30,
      });
      await sleep(8e3);
      const popup = context.extensionRuntime.popupView();
      if (popup) {
        console.log(
          `popup text: ${JSON.stringify(await evaluate(popup, 'document.body.innerText.slice(0, 400)'))}`,
        );
        await screenshot(popup, 'extension-popup');
      } else console.log('popup: not open');
    }
    // Regression check for a real bug report ("Responsive Viewer does nothing"), root-caused by
    // hand against the extension's own real background.js: it has no popup, so a click fires
    // action.onClicked, which builds declarativeNetRequest rules using chrome.declarativeNetRequest
    // .HeaderOperation (missing from the shim entirely — a plain property-access TypeError, thrown
    // synchronously deep in the extension's own rule builder, silently swallowed by its own
    // Promise.all/.catch chain with no console output at all) and then, once that no longer throws,
    // waits for chrome.webNavigation.onCommitted to tell it the (reloaded) tab's own url so it can
    // check the hostname before injecting — which `seen()` above was withholding because this
    // extension has only `activeTab`, not `tabs` or host_permissions, and activeTab was not one of
    // the ways `seen()` would let the url through (real Chrome's webNavigation API does honor
    // activeTab for this). Both fixed in this same change; verified here end to end with the real
    // extension: a real click makes its real UI (`RESPONSIVE-VIEWER-ROOT`) actually appear.
    if (GLib.getenv('WEBSWITCH_SELFTEST_STORE_POPUP') === 'responsive') {
      const target = tabs.createTab(
        GLib.getenv('WEBSWITCH_SELFTEST_RV_URL') ?? `${SITE}/index.html`,
      );
      const targetView = tabs.viewOfTab(target);
      if (targetView) {
        await sleep(3e3);
        await context.extensionRuntime.openPopup(wanted, { x: 900, y: 30, width: 30, height: 30 });
        let root = false;
        for (let second = 1; second <= 8 && !root; second++) {
          await sleep(1e3);
          root = Boolean(
            await evaluate(targetView, "!!document.getElementById('RESPONSIVE-VIEWER-ROOT')"),
          );
        }
        check(
          "a click on Responsive Viewer's toolbar button (it has no popup) injects its real UI",
          root,
        );
        await sleep(6e3);
        await screenshot(targetView, 'responsive-viewer-after-click');
      }
    }
    extensions.remove(wanted);
  }
}
/**
 * WEBSWITCH_SELFTEST_EXTENSIONS=coldstart-install: turns extensions on, installs and enables the
 * `hello` fixture, then quits. The first half of a two-run check (paired with coldstart-check)
 * that an already-installed, already-enabled extension gets its background page at the next quiet
 * start, not only when something later changes its state. Run both with the same
 * WEBSWITCH_SELFTEST_OUT (it is also the parent of the private XDG_CONFIG_HOME/XDG_DATA_HOME), so
 * the second run finds what this one installed.
 */
async function coldstartInstall(context: BrowserContext): Promise<void> {
  const { extensions, settings } = context;
  const fixture = (name: string) =>
    GLib.build_filenamev([GLib.get_current_dir(), 'tests/extensions', name]);
  check('the switch turns on', settings.set('extensions', true).ok);
  const prepared = await extensions.prepareFromFolder(fixture('hello'));
  check('the fixture prepares', prepared.ok, JSON.stringify(prepared));
  if (!prepared.ok) return;
  const confirmed = await extensions.confirm();
  check(
    'and installs, enabled',
    confirmed.ok && extensions.active().length === 1,
    JSON.stringify(confirmed),
  );
}
/**
 * WEBSWITCH_SELFTEST_EXTENSIONS=coldstart-check: run right after coldstart-install with the same
 * WEBSWITCH_SELFTEST_OUT. Nothing here installs, enables, disables or otherwise touches an
 * extension's state before the checks below, so the only way the background page can already be
 * running is the constructor's own proactive refresh() — this guards against a background page
 * that only ever starts reactively, from an event a quiet start never fires.
 */
async function coldstartCheck(context: BrowserContext): Promise<void> {
  const { extensions, extensionRuntime, tabs } = context;
  const loaded = extensions.active();
  check(
    'the extension installed by the previous run is already there and enabled',
    loaded.length === 1,
    JSON.stringify(loaded.map((extension) => extension.meta)),
  );
  const id = loaded[0]?.meta.id ?? '';
  const opened = tabs.createTab(`${SITE}/index.html`);
  const view = tabs.viewOfTab(opened);
  await waitFor(() => view !== null && !view.is_loading);
  await sleep(1500);
  const port = view
    ? String(await evaluate(view, 'document.documentElement.dataset.port ?? null'))
    : 'no view';
  check(
    'a content script loaded on this fresh, quiet start reaches the background page over a port',
    port.includes('"echo":{"hi":1}'),
    port,
  );
  const state =
    id === '' ? 'no id' : await extensionRuntime.evaluateInBackground(id, 'JSON.stringify(state)');
  check('and asking the background page directly also answers', state !== 'undefined', state);
}
System.exit(
  runBrowser({
    appId: 'dev.webswitch.Selftest',
    onReady: async (context) => {
      try {
        const probeUrl = GLib.getenv('WEBSWITCH_SELFTEST_URL');
        await (probeUrl
          ? pageProbe(context, probeUrl)
          : GLib.getenv('WEBSWITCH_SELFTEST_EXTENSIONS') === 'store'
            ? storeScenario(context)
            : GLib.getenv('WEBSWITCH_SELFTEST_EXTENSIONS') === 'coldstart-install'
              ? coldstartInstall(context)
              : GLib.getenv('WEBSWITCH_SELFTEST_EXTENSIONS') === 'coldstart-check'
                ? coldstartCheck(context)
                : GLib.getenv('WEBSWITCH_SELFTEST_EXTENSIONS') === '1'
                  ? extensionsScenario(context)
                  : GLib.getenv('WEBSWITCH_SELFTEST_BROWSERS') === 'fit'
                    ? fitScenario(context)
                    : GLib.getenv('WEBSWITCH_SELFTEST_BROWSERS') === '1'
                      ? browsersScenario(context)
                      : scenario(context));
      } catch (error) {
        failures++;
        console.log(`FAIL scenario threw: ${String(error)}`);
      }
      console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
      context.app.quit();
    },
  }) || (failures === 0 ? 0 : 1),
);
