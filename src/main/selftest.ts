import GLib from 'gi://GLib?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';
import System from 'system';
import type { BrowserContext } from '~types/bootstrap';
import type { TabsState } from '~types/tabs';
import { runBrowser } from './core/bootstrap';
import { readText } from './core/files';
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

async function waitFor(condition: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
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
  for (let waited = 0; waited < 8000; waited += 50) {
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
  const texture = await view.get_snapshot(
    WebKit.SnapshotRegion.VISIBLE,
    WebKit.SnapshotOptions.NONE,
    null,
  );
  texture.save_to_png(`${OUT}/${name}.png`);
}

/** The whole window as GTK composes it: the UI, the page area, overlays. */
function windowShot(context: BrowserContext, name: string): void {
  const { overlay, window } = context.main;
  const width = overlay.get_width();
  const height = overlay.get_height();
  const snapshot = new Gtk.Snapshot();
  new Gtk.WidgetPaintable({ widget: overlay }).snapshot(snapshot, width, height);
  const node = snapshot.to_node();
  const texture = node ? window.get_native()?.get_renderer()?.render_texture(node, null) : null;
  texture?.save_to_png(`${OUT}/${name}.png`);
}

async function scenario(context: BrowserContext): Promise<void> {
  const { main, ui, tabs, history, shortcuts, menu, menuView } = context;
  const ipc = <T>(expression: string): Promise<T> => evaluate(ui, expression) as Promise<T>;
  const state = (): TabsState => tabs.getState();
  const activeView = (): WebKit.WebView => {
    const view = tabs.getActiveView();
    if (!view) throw new Error('no active tab');
    return view;
  };
  const engine = `WebKitGTK ${WebKit.get_major_version()}.${WebKit.get_minor_version()}.${WebKit.get_micro_version()}`;
  console.log(`engine: ${engine}`);

  // ── The UI loads through webswitch:// and the bridge answers ────────────────────────────────
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
  check(
    'page area starts below the chrome',
    main.stack.get_margin_top() === Math.ceil(chromeHeight),
    `chrome ${chromeHeight}px, margin ${main.stack.get_margin_top()}px`,
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
    (await ipc<string>("document.querySelector('.wordmark')?.textContent ?? ''")) === '.webswitch',
  );
  console.log(
    `info: window ${main.window.get_width()}x${main.window.get_height()}, overlay ${main.overlay.get_width()}x${main.overlay.get_height()}`,
  );
  await screenshot(ui, 'ui-blank');
  windowShot(context, 'window-blank');

  // ── Navigating ──────────────────────────────────────────────────────────────────────────────
  await ipc(`window.browserApi.navigation.navigate('${SITE}/index.html')`);
  check(
    'navigates through the UI',
    await waitFor(() => state().tabs[0]?.title === 'Local Test Page'),
    JSON.stringify(state().tabs[0]),
  );
  check('page area is visible for a web page', main.stack.get_visible());
  await sleep(500);
  const history1 = history.query('', 10);
  check(
    'visit recorded in history',
    history1.some((entry) => entry.url === `${SITE}/index.html`),
  );
  await screenshot(ui, 'ui-page');
  await screenshot(activeView(), 'tab-page');
  windowShot(context, 'window-page');

  // ── target=_blank becomes a tab; window.open with a size stays a linked popup ───────────────
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
  const windowCount = (): number => Gtk.Window.list_toplevels().length;
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
  // Popups are the windows transient for the main one.
  for (const popup of Gtk.Window.list_toplevels()) {
    if (popup instanceof Gtk.Window && popup.get_transient_for() !== null) popup.close();
  }

  // ── Shortcuts and keybindings ───────────────────────────────────────────────────────────────
  const count = state().tabs.length;
  check('Ctrl+T opens a tab', shortcuts.trigger('Ctrl+T') && state().tabs.length === count + 1);
  // The real path: a GDK key event reaching the window's key controller.
  const controllers = main.window.observe_controllers();
  const keyControllers: Gtk.EventControllerKey[] = [];
  for (let i = 0; i < controllers.get_n_items(); i++) {
    const controller = controllers.get_item(i);
    // Ours is one of the controllers that runs first (capture phase); GTK has one of its own too.
    if (
      controller instanceof Gtk.EventControllerKey &&
      controller.get_propagation_phase() === Gtk.PropagationPhase.CAPTURE
    ) {
      keyControllers.push(controller);
    }
  }
  const press = (keyval: number, modifiers: Gdk.ModifierType): void => {
    for (const controller of keyControllers) {
      GObject.signal_emit_by_name(controller, 'key-pressed', keyval, 0, modifiers);
    }
  };
  await sleep(400); // past the repeat guard, so the next key press is not taken for a held key
  const beforeKey = state().tabs.length;
  press(Gdk.KEY_t, Gdk.ModifierType.CONTROL_MASK);
  check('a real Ctrl+T key event opens a tab', state().tabs.length === beforeKey + 1);
  press(Gdk.KEY_w, Gdk.ModifierType.CONTROL_MASK);
  check('a real Ctrl+W key event closes it', state().tabs.length === beforeKey);
  press(Gdk.KEY_ISO_Left_Tab, Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.SHIFT_MASK);
  press(Gdk.KEY_Tab, Gdk.ModifierType.CONTROL_MASK);
  const kb = await ipc<{ ok: boolean }>(
    "window.browserApi.keybindings.set('newTab', ['Ctrl+Shift+K'])",
  );
  check('editing a shortcut through IPC works', kb.ok);
  await sleep(400);
  check('the old shortcut no longer fires', !shortcuts.trigger('Ctrl+T'));
  check('the new shortcut fires', shortcuts.trigger('Ctrl+Shift+K'));
  const conflict = await ipc<{ ok: boolean }>(
    "window.browserApi.keybindings.set('closeTab', ['Ctrl+Shift+K'])",
  );
  check('a conflicting shortcut is refused', !conflict.ok);
  await ipc('window.browserApi.keybindings.resetAll()');

  // ── The menu popover ────────────────────────────────────────────────────────────────────────
  await ipc(
    "(() => { const r = document.querySelector('.menu-button').getBoundingClientRect(); return window.browserApi.menu.toggle(Math.round(r.right), Math.round(r.bottom)); })()",
  );
  check('the menu popover opens', await waitFor(() => menu.isOpen()));
  main.window.present();
  const mapped = await waitFor(() => menuView.get_width() > 0, 3000);
  if (!mapped)
    console.log(
      'info: the compositor did not map the popover for this synthetic open (a real click gives it the input serial it needs)',
    );
  console.log(`info: menu view is ${menuView.get_width()}x${menuView.get_height()}`);
  const popover = menuView.get_ancestor(Gtk.Popover.$gtype);
  console.log(
    `info: popover is ${popover?.get_width()}x${popover?.get_height()}; view measures ${menuView.measure(Gtk.Orientation.HORIZONTAL, -1).slice(0, 2).join('/')} x ${menuView.measure(Gtk.Orientation.VERTICAL, -1).slice(0, 2).join('/')}; parent ${menuView.get_parent()?.constructor.name}`,
  );
  if (mapped) {
    check(
      'the menu is as small as its icons',
      menuView.get_width() < 120 && menuView.get_height() < 400,
      `${menuView.get_width()}x${menuView.get_height()}`,
    );
  }
  check(
    'the menu button shows it is open',
    (await ipc<string>("document.querySelector('.menu-button').getAttribute('aria-expanded')")) ===
      'true',
  );
  const items = (await evaluate(
    menuView,
    "[...document.querySelectorAll('.menu-item')].map((b) => b.title)",
  )) as string[];
  check('the menu lists 5 icon-only items', items.length === 5, items.join(' | '));
  await screenshot(menuView, 'menu').catch(() => {
    console.log('info: no menu screenshot (the popover was not mapped)');
  });
  windowShot(context, 'window-menu');
  await evaluate(menuView, "document.querySelectorAll('.menu-item')[3].click()");
  check(
    'choosing History opens the History page',
    await waitFor(() => state().tabs.some((tab) => tab.page === 'history')),
  );
  check('and closes the menu', await waitFor(() => !menu.isOpen()));
  await sleep(1000);
  check(
    'History page lists visits',
    (await ipc<number>("document.querySelectorAll('.hist-row').length")) > 0,
  );
  await screenshot(ui, 'ui-history');
  tabs.openPage('keybindings');
  await sleep(1000);
  check(
    'Keybindings page lists the actions',
    (await ipc<number>("document.querySelectorAll('.kb-row').length")) >= 15,
  );
  await screenshot(ui, 'ui-keybindings');

  // ── DevTools, zoom, failed load, closing ────────────────────────────────────────────────────
  await ipc(`window.browserApi.navigation.navigate('${SITE}/two.html')`);
  await waitFor(
    () => state().tabs.find((tab) => tab.id === state().activeTabId)?.title === 'Page Two',
  );
  tabs.toggleDevTools();
  check(
    'the Web Inspector opens',
    await waitFor(() => activeView().get_inspector().get_web_view() !== null),
  );
  tabs.toggleDevTools();
  tabs.zoomActiveTab('in');
  check(
    'zoom in',
    Math.abs(activeView().get_zoom_level() - 1.1) < 0.001,
    String(activeView().get_zoom_level()),
  );
  tabs.zoomActiveTab('reset');

  // DRM sites are handed to a Chromium app window; the tab must stay where it was.
  const urlBefore = state().tabs.find((tab) => tab.id === state().activeTabId)?.url;
  await ipc("window.browserApi.navigation.navigate('https://www.netflix.com/browse')");
  const drmArgs = await readText(GLib.build_filenamev([OUT, 'drm-args.txt']));
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

  await ipc("window.browserApi.navigation.navigate('http://localhost:59999/')");
  check(
    'a failed load is reported',
    await waitFor(() => state().tabs.find((tab) => tab.id === state().activeTabId)?.error != null),
  );
  check('and shows the UI message, not a blank page', !main.stack.get_visible());
  await sleep(500);
  await screenshot(ui, 'ui-error');

  for (let i = 0; i < 20 && state().tabs.length > 0; i++) tabs.closeActiveTab();
  check(
    'closing the last tab leaves one blank tab',
    state().tabs.length === 1 && state().tabs[0]?.url === '',
  );
  await sleep(500);
  windowShot(context, 'window-end');
}

System.exit(
  runBrowser({
    appId: 'dev.webswitch.Selftest',
    onReady: async (context) => {
      try {
        await scenario(context);
      } catch (error) {
        failures++;
        console.log(`FAIL scenario threw: ${String(error)}`);
      }
      console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
      context.app.quit();
    },
  }) || (failures === 0 ? 0 : 1),
);
