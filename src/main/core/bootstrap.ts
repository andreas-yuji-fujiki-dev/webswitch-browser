import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';
import System from 'system';
import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { BootstrapOptions, BrowserContext } from '~types/bootstrap';
import { APP_ID, APP_NAME, searchEngineFor, UI_HOST, UI_SCHEME } from './config';
import { debug } from './debug';
import { InspectorFrame } from './inspector-frame';
import { handleDownloads } from './downloads';
import { applyGpuChoice } from './gpu';
import { applySessionPreferences, applyTabPreferences } from './preferences';
import { captureEnvironment, restartBrowser } from './restart';
import { ensureDir, readText } from './files';
import { IpcRouter } from './ipc-router';
import { migrateLegacyData } from './legacy-migration';
import { cacheDir, configDir, dataDir, distDir } from './paths';
import { openPopupWindow } from './popup-window';
import { BROWSERS } from '~shared/browsers-catalog';
import { WEB_STORE_URL } from '~shared/crx';
import type { BrowserId } from '~types/browsers';
import type { RequestVerdict } from '~types/extensions';
import type { DrmBrowser } from '~types/drm';
import { askCredentials } from './auth-dialog';
import { chooseFolder, chooseJsonFile } from './file-dialog';
import { followSystemColorScheme, setChromeColors } from './theme';
import { registerUiIpc } from './ui-ipc';
import { loadUiState, saveUiState } from './ui-state';
import { registerUiScheme } from './ui-scheme';
import { createTabView, createUiView } from './webviews';
import { registerExtensionsIpc } from '../features/extensions/extensions.ipc';
import { ExtensionRuntime } from '../features/extensions/extension-runtime';
import { registerExtensionScheme } from '../features/extensions/extension-scheme';
import { ExtensionsService } from '../features/extensions/extensions.service';
import { MainWindow, refreshWindowStyles } from './window';
import { resolveInput } from '../features/navigation/url-resolver';
import { isWebUrl, parseUrl } from './url';
import { registerAccountIpc } from '../features/account/account.ipc';
import { AccountService } from '../features/account/account.service';
import { registerSettingsIpc } from '../features/settings/settings.ipc';
import { SettingsService } from '../features/settings/settings.service';
import { DevToolsPanelService } from '../features/devtools/devtools-panel.service';
import { registerDevToolsIpc } from '../features/devtools/devtools.ipc';
import { registerDevToolsScheme } from '../features/devtools/devtools-scheme';
import { DevToolsService } from '../features/devtools/devtools.service';
import { OpenVsx } from '../features/themes/openvsx';
import { Http } from './http';
import { registerThemesIpc } from '../features/themes/themes.ipc';
import { ThemesService } from '../features/themes/themes.service';
import { registerBrowsersIpc } from '../features/browsers/browsers.ipc';
import { anyBrowserInstalled, BrowsersService } from '../features/browsers/browsers.service';
import { registerBookmarksIpc } from '../features/bookmarks/bookmarks.ipc';
import { BookmarksService } from '../features/bookmarks/bookmarks.service';
import { BookmarksPopup } from './bookmarks-popup';
import { registerCookiesIpc } from '../features/cookies/cookies.ipc';
import { CookiesService } from '../features/cookies/cookies.service';
import { DrmService } from '../features/drm/drm.service';
import {
  EmbedService,
  embeddingAvailable,
  embeddingRequested,
} from '../features/drm/embed.service';
import { registerHistoryIpc } from '../features/history/history.ipc';
import { HistoryService } from '../features/history/history.service';
import { registerKeybindingsIpc } from '../features/keybindings/keybindings.ipc';
import { KeybindingsService } from '../features/keybindings/keybindings.service';
import { registerMenuIpc } from '../features/menu/menu.ipc';
import { MenuService } from '../features/menu/menu.service';
import { registerNavigationIpc } from '../features/navigation/navigation.ipc';
import { NavigationService } from '../features/navigation/navigation.service';
import { PermissionsService } from '../features/permissions/permissions.service';
import { ShortcutsService } from '../features/shortcuts/shortcuts.service';
import { registerTabsIpc } from '../features/tabs/tabs.ipc';
import { TabsService } from '../features/tabs/tabs.service';
import { registerUserCssIpc } from '../features/user-css/user-css.ipc';
import { UserCssService } from '../features/user-css/user-css.service';

function color(hex: string): Gdk.RGBA {
  const rgba = new Gdk.RGBA();
  rgba.parse(hex);
  return rgba;
}

async function start(
  app: Gtk.Application,
  options: BootstrapOptions,
  settings: SettingsService,
): Promise<BrowserContext> {
  followSystemColorScheme();
  ensureDir(configDir());
  ensureDir(dataDir());
  ensureDir(cacheDir());
  await migrateLegacyData();

  const dist = distDir();
  const themes = new ThemesService();
  setChromeColors(themes.resolved().colors);
  // theme.css is made from the theme in use, so the UI starts with its colors: no flash of the old ones.
  registerUiScheme(GLib.build_filenamev([dist, 'renderer']), (name) =>
    name === 'theme.css' ? themes.css() : null,
  );
  const devtools = new DevToolsService();
  registerDevToolsScheme(devtools);
  debug('devtools', `state at start: ${JSON.stringify(devtools.getState())}`);
  const preload = await readText(GLib.build_filenamev([dist, 'preload.js']));
  if (preload === null) throw new Error('dist/preload.js is missing; run `npm run build`');

  // One persistent session for every tab (cookies, storage, cache); the UI gets a throwaway one.
  const session = WebKit.NetworkSession.new(
    GLib.build_filenamev([dataDir(), 'web']),
    GLib.build_filenamev([cacheDir(), 'web']),
  );
  session
    .get_cookie_manager()
    .set_persistent_storage(
      GLib.build_filenamev([dataDir(), 'cookies.sqlite']),
      WebKit.CookiePersistentStorage.SQLITE,
    );
  handleDownloads(session, () => settings.get('downloadFolder'));
  applySessionPreferences(session, settings);
  // Spellcheck dictionaries would be downloaded from a server, so spellcheck stays off.
  WebKit.WebContext.get_default().set_spell_checking_enabled(false);

  const permissions = new PermissionsService();
  const router = new IpcRouter();
  const uiSession = WebKit.NetworkSession.new_ephemeral();
  const uiView = createUiView(
    { session: uiSession, router, preload },
    color(themes.resolved().colors.bg),
  );
  const menuView = createUiView(
    { session: uiSession, router, preload },
    color(themes.resolved().colors.bg),
    uiView,
  );
  // The star's edit form and a bookmarks-bar folder's contents: a real Gtk.Popover (see
  // bookmarks-popup.ts for why), over a fresh related view each time so it always starts clean.
  const bookmarksPopup = new BookmarksPopup(
    uiView,
    () =>
      createUiView(
        { session: uiSession, router, preload },
        color(themes.resolved().colors.bg),
        uiView,
      ),
    (view) => {
      router.untrack(view);
    },
  );

  const main = new MainWindow(app, uiView);
  let uiInspectorTab: number | null = null;
  const inspectorFrame = new InspectorFrame(main);
  const devtoolsPanel = new DevToolsPanelService(
    main,
    devtools,
    uiView,
    color(themes.resolved().colors.bg),
    (url) => {
      tabs.createTab(url);
    },
  );
  inspectorFrame.watch(uiView);
  // The menu panel keeps the width the user gave it, also across runs.
  const uiState = await loadUiState();
  if (uiState.menuFraction !== undefined) main.setSidePanelFraction(uiState.menuFraction, false);
  if (uiState.devtoolsFraction !== undefined) {
    main.setDevToolsFraction(uiState.devtoolsFraction, false);
  }
  main.onDevToolsFraction((fraction, committed) => {
    if (committed) void saveUiState({ devtoolsFraction: fraction });
  });
  main.onSidePanelFraction((fraction, committed) => {
    if (committed) void saveUiState({ menuFraction: fraction });
  });
  const focusUi = (): void => {
    uiView.grab_focus();
  };
  const focusAddressBar = (): void => {
    focusUi();
    router.emit(IPC_CHANNELS.ui.focusAddressBar, null);
  };

  const keybindings = new KeybindingsService();
  const history = new HistoryService();
  const bookmarks = new BookmarksService();
  const userCss = new UserCssService();
  const account = new AccountService(session);
  const browsers = new BrowsersService(
    (): string | null => drm.findSystemBrowser()?.name ?? null,
    () => ({ available: embed !== null, wanted: settings.get('embedStreaming') }),
  );
  // Netflix, Spotify and the like use the browser chosen in Test in other browsers, else the system's.
  const drm = new DrmService((): DrmBrowser | null => browsers.streamingExecutable());
  // Hosts of the pages open tabs are on; a cookie that is only allowed on some sites follows them.
  const openHosts = (): string[] =>
    tabs
      .getState()
      .tabs.map((tab) => parseUrl(tab.url)?.host)
      .filter((host): host is string => host !== undefined && host !== null);
  const cookies = new CookiesService(session, openHosts);
  // A DRM page goes to an embedded Chromium window when embedding is on, else to an app window.
  const routeDrm = (url: string, source?: WebKit.WebView): boolean => {
    if (!drm.needsDrm(url)) return false;
    if (embed !== null && tabs.openEmbedded(url, source)) return true;
    if (!drm.handOff(url)) return false;
    // The page is shown by another program, but it is still a visit.
    history.record({ url, title: parseUrl(url)?.host ?? url });
    return true;
  };
  const tabs = new TabsService({
    stack: main.stack,
    createView: (related) =>
      createTabView(
        {
          session,
          permissions,
          prefs: settings,
          handOff: routeDrm,
          prepareNavigation: (url) => (cookies.needsPrepare(url) ? cookies.prepare(url) : null),
          attachExtensions: (view) => {
            extensionRuntime.attachTab(view);
          },
          allowExtensionNavigation: (view, uri): boolean =>
            extensionRuntime.allowsTabNavigation(view, uri),
          reportHttpError: (view, url, status): void => {
            tabs.reportHttpError(view, url, status);
          },
          interceptNavigation: (view, url, type): RequestVerdict | Promise<RequestVerdict> | null =>
            extensionRuntime.interceptNavigation(view, url, type),
          authenticate: (view, request) => {
            // Sign-in with a certificate or a trust question is not a password: WebKit's own handling stays.
            const kind = request.get_scheme();
            if (
              kind === WebKit.AuthenticationScheme.CLIENT_CERTIFICATE_REQUESTED ||
              kind === WebKit.AuthenticationScheme.SERVER_TRUST_EVALUATION_REQUESTED
            ) {
              return false;
            }
            // An extension that keeps logins (a password manager) may answer first.
            if (
              !extensionRuntime.authenticate(view, request, () => {
                askCredentials(main.window, request);
              })
            ) {
              askCredentials(main.window, request);
            }
            return true;
          },
        },
        related,
      ),
    focusAddressBar,
    focusUi,
    onPageVisit: (visit) => {
      history.record(visit);
    },
    handOff: routeDrm,
    needsCookiePrep: (url) => cookies.needsPrepare(url),
    prepareCookies: (url) => cookies.prepare(url),
    needsDrm: (url) => drm.needsDrm(url),
    attachEmbed: (view, url) => embed?.attach(view, drm.embedSpec(url)) ?? null,
    attachBrowser: (view, spec) => embed?.attach(view, spec) ?? null,
    openPopup: (view) => {
      openPopupWindow(main.window, view);
    },
    useChromeDevTools: () => devtools.activeProvider() !== 'webkit',
    toggleChromeDevTools: (view, tabId) => {
      devtoolsPanel.toggle(view, tabId);
    },
    watchInspector: (view) => {
      inspectorFrame.watch(view);
    },
    toggleUiDevTools: (tabId) => {
      // Chrome DevTools (or a downloaded one) inspects the UI like it does a page.
      if (devtools.activeProvider() !== 'webkit') {
        devtoolsPanel.toggle(uiView, tabId);
        return;
      }
      // The UI view only gets the inspector once somebody asks for it.
      uiView.get_settings().set_enable_developer_extras(true);
      const inspector = uiView.get_inspector();
      if (inspector.get_web_view()) {
        inspector.close();
      } else {
        inspector.show();
        uiInspectorTab = tabId;
      }
    },
    setContentFullscreen: (fullscreen) => {
      main.setContentFullscreen(fullscreen);
    },
  });
  const navigation = new NavigationService(tabs, settings);
  // Extensions run only while the switch in General settings is on (see ExtensionsService.active).
  const http = new Http();
  const extensions = new ExtensionsService(http, () => settings.get('extensions'));
  const extensionRuntime = new ExtensionRuntime(
    extensions,
    {
      listTabs: () => tabs.briefs(),
      tabIdOf: (view) => tabs.idOfView(view),
      viewOf: (id) => tabs.viewOfTab(id),
      createTab: (url, activate) => tabs.createTab(url, { activate }),
      activateTab: (id) => {
        tabs.activateTab(id);
      },
      updateTab: (id, url) => {
        tabs.loadUrl(id, url);
      },
      closeTab: (id) => {
        tabs.closeTab(id);
      },
      reloadTab: (id) => {
        tabs.reloadTab(id);
      },
      recentlyClosed: () => tabs.recentlyClosed(),
      onTabsChanged: (listener) => {
        tabs.onStateChanged(listener);
      },
    },
    http,
    uiView,
    {
      cookieManager: session.get_cookie_manager(),
      allCookies: () => cookies.allSoupCookies(),
      history,
      session,
      app,
      searchUrl: (text) =>
        resolveInput(text, searchEngineFor(settings.get('searchEngine'))) ?? 'about:blank',
    },
  );
  registerExtensionScheme(extensionRuntime);
  const menu = new MenuService(main, menuView);
  const embed = embeddingAvailable(settings.get('embedStreaming'), anyBrowserInstalled())
    ? new EmbedService(main.window)
    : null;

  const shortcuts = new ShortcutsService(
    {
      newTab: () => {
        tabs.createTab();
      },
      closeTab: () => {
        tabs.closeActiveTab();
      },
      reopenClosedTab: () => {
        tabs.reopenClosedTab();
      },
      nextTab: () => {
        tabs.cycleTab(1);
      },
      previousTab: () => {
        tabs.cycleTab(-1);
      },
      lastTab: () => {
        tabs.activateLastTab();
      },
      openHistory: () => {
        tabs.openPage('history');
      },
      bookmarkPage: () => {
        router.emit(IPC_CHANNELS.bookmarks.shortcut, null);
      },
      focusAddressBar,
      reload: () => {
        navigation.reload();
      },
      hardReload: () => {
        navigation.hardReload();
      },
      goBack: () => {
        navigation.goBack();
      },
      goForward: () => {
        navigation.goForward();
      },
      toggleDevTools: () => {
        tabs.toggleDevTools();
      },
      zoomIn: () => {
        tabs.zoomActiveTab('in');
      },
      zoomOut: () => {
        tabs.zoomActiveTab('out');
      },
      zoomReset: () => {
        tabs.zoomActiveTab('reset');
      },
      activateTabAt: (position) => {
        tabs.activateTabAtPosition(position);
      },
    },
    keybindings,
  );
  shortcuts.attach(main.window);
  shortcuts.setExtraShortcuts((accelerator, repeated) =>
    extensionRuntime.handleShortcut(accelerator, repeated),
  );

  registerTabsIpc(router, tabs);
  registerNavigationIpc(router, navigation);
  registerMenuIpc(router, menu);
  registerKeybindingsIpc(router, keybindings, shortcuts);
  registerHistoryIpc(router, history);
  registerBookmarksIpc(router, bookmarks);
  router.handle(IPC_CHANNELS.bookmarks.openPopup, (kind, itemId, x, y, width, height) => {
    const query =
      itemId !== null && (kind === 'folder' || kind === 'folder-menu' || kind === 'bookmark')
        ? `kind=${kind}&id=${encodeURIComponent(itemId)}`
        : `kind=${kind}`;
    const size = {
      folder: { width: 240, height: 320 },
      // Sized for the add-bookmark form (the bigger of the three it can switch to in place: its
      // own rename fields, "Add bookmark here…", or "Add folder here…"), so switching never
      // needs the popover itself to resize.
      'folder-menu': { width: 300, height: 300 },
      bookmark: { width: 300, height: 280 },
      star: { width: 300, height: 280 },
      // Sized for the add-bookmark form (the bigger of the two it can switch to in place), so
      // switching from the menu to either form never needs the popover itself to resize.
      'add-menu': { width: 300, height: 300 },
    }[kind];
    bookmarksPopup.open(
      `${UI_SCHEME}://${UI_HOST}/index.html?view=bookmarks-popup&${query}`,
      { x, y, width, height },
      size,
    );
  });
  router.handle(IPC_CHANNELS.bookmarks.closePopup, () => {
    bookmarksPopup.close();
  });
  registerBrowsersIpc(router, browsers, (id) => {
    menu.close();
    if (!BROWSERS.some((browser) => browser.id === id))
      return { ok: false, error: 'Unknown browser.' };
    const active = tabs.getState().tabs.find((tab) => tab.id === tabs.getState().activeTabId);
    const url = active !== undefined && isWebUrl(active.url) ? active.url : 'about:blank';
    if (id === 'webkit') {
      // Webswitch itself: a new tab with the same page.
      tabs.createTab(url === 'about:blank' ? undefined : url);
      return { ok: true };
    }
    if (!browsers.isInstalled(id as BrowserId)) {
      tabs.openPage('browsers');
      browsers.requestFocus(id as BrowserId);
      return { ok: false, error: 'It is not installed yet.' };
    }
    const spec = browsers.embedSpec(id as BrowserId, url);
    if (spec === null || embed === null) {
      tabs.openPage('browsers');
      return { ok: false, error: 'Tabs cannot show other browsers yet (see the top of the page).' };
    }
    return tabs.openInBrowser(url, spec)
      ? { ok: true }
      : { ok: false, error: 'The browser did not start.' };
  });
  const openVsx = new OpenVsx(http, themes);
  registerThemesIpc(router, themes, openVsx, () =>
    chooseJsonFile(main.window, 'Choose a theme file'),
  );
  // A new theme recolors what GTK and the web views draw themselves; the UI reloads theme.css.
  themes.onChanged(() => {
    const colors = themes.resolved().colors;
    setChromeColors(colors);
    refreshWindowStyles();
    const background = color(colors.bg);
    uiView.set_background_color(background);
    menuView.set_background_color(background);
    devtoolsPanel.setBackground(background);
  });
  registerExtensionsIpc(
    router,
    extensions,
    extensionRuntime,
    () => chooseFolder(main.window, 'Choose the folder of an unpacked extension'),
    () => {
      tabs.createTab(WEB_STORE_URL);
    },
  );
  registerDevToolsIpc(router, devtools);
  registerSettingsIpc(router, settings, () => {
    const urls = tabs
      .getState()
      .tabs.map((tab) => tab.url)
      .filter(isWebUrl);
    if (!restartBrowser(app, urls)) debug('restart', 'no command to start the browser again');
  });
  // What can change while the browser runs takes effect on every open tab at once.
  settings.onChanged(() => {
    tabs.forEachView((view) => {
      applyTabPreferences(view.get_settings(), settings);
    });
    applySessionPreferences(session, settings);
    // The switch for extensions is one of the settings: the extensions page and the runtime follow it.
    extensions.settingsChanged();
  });
  registerCookiesIpc(router, cookies, (url) => {
    tabs.createTab(url);
  });
  registerAccountIpc(router, account);
  registerUserCssIpc(router, userCss);
  registerUiIpc(router, main);
  // Closing the panel hands the keyboard back to the page.
  menu.onStateChanged(({ open }) => {
    if (!open) tabs.focusContent();
  });
  menu.onSelect((itemId) => {
    if (itemId === 'keybindings' || itemId === 'history') tabs.openPage(itemId);
    if (itemId === 'user') tabs.openPage('cookies');
    if (itemId === 'settings') tabs.openPage('settings');
    if (itemId === 'themes') tabs.openPage('themes');
    if (itemId === 'extensions') tabs.openPage('extensions');
    if (itemId === 'browsers') tabs.openPage('browsers');
    if (itemId === 'devSettings') tabs.openPage('dev-settings');
  });

  // Keep the window title in sync with the active tab.
  tabs.onStateChanged((state) => {
    // Tabs moved between sites: cookies that are only allowed on some sites may have to come or go.
    cookies.scheduleSync();
    // The DevTools panel follows the active tab.
    const live = new Set<WebKit.WebView>();
    tabs.forEachView((view) => live.add(view));
    devtoolsPanel.sync(
      tabs.getActiveView() ?? null,
      main.stack.get_visible(),
      live,
      state.activeTabId,
    );
    // The UI is one document shared by the home page and every built-in page: what is inspected
    // there belongs to the tab it was opened from, and closes when another tab is shown.
    if (uiInspectorTab !== null && state.activeTabId !== uiInspectorTab) {
      uiView.get_inspector().close();
      uiInspectorTab = null;
    }
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    main.window.set_title(active?.title ? `${active.title} — ${APP_NAME}` : APP_NAME);
  });
  app.connect('shutdown', () => {
    userCss.dispose();
  });

  await Promise.all([
    userCss.init(),
    keybindings.init(),
    history.init(),
    bookmarks.init(),
    account.init(),
    cookies.init(),
  ]);

  // Tell the UI how wide the window buttons are once they have been laid out.
  const announceControls = (): void => {
    router.emit(IPC_CHANNELS.ui.windowControls, { width: main.controlsWidth() });
  };
  uiView.connect('load-changed', (_view, event) => {
    if (event !== WebKit.LoadEvent.FINISHED) return;
    announceControls();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
      announceControls();
      return GLib.SOURCE_REMOVE;
    });
  });

  main.window.present();
  uiView.load_uri(`${UI_SCHEME}://${UI_HOST}/index.html?view=browser`);
  menuView.load_uri(`${UI_SCHEME}://${UI_HOST}/index.html?view=menu`);
  tabs.createTab();

  const context: BrowserContext = {
    app,
    main,
    ui: uiView,
    router,
    session,
    menuView,
    tabs,
    navigation,
    shortcuts,
    keybindings,
    history,
    bookmarks,
    bookmarksPopup,
    userCss,
    account,
    cookies,
    settings,
    browsers,
    extensions,
    extensionRuntime,
    drm,
    themes,
    openVsx,
    devtools,
    devtoolsPanel,
    menu,
  };
  await options.onReady?.(context);
  return context;
}

/** What the user typed on the command line becomes tabs: the first fills a blank tab if that is all there is. */
function openFromCommandLine(context: BrowserContext, inputs: string[]): void {
  const urls = inputs
    .map((input) => resolveInput(input, searchEngineFor(context.settings.get('searchEngine'))))
    .filter((url): url is string => url !== null);
  const { tabs } = context;
  urls.forEach((url, index) => {
    const state = tabs.getState();
    const onlyBlank =
      state.tabs.length === 1 && state.tabs[0]?.url === '' && state.tabs[0].page === null;
    if (index === 0 && onlyBlank && state.activeTabId !== null) {
      tabs.loadUrl(state.activeTabId, url);
      tabs.focusContent();
    } else {
      tabs.createTab(url);
    }
  });
}

/**
 * Starts the browser and returns the process exit code when the last window is closed.
 * Addresses or searches given on the command line open as tabs, in the running browser if there is one.
 */
export function runBrowser(options: BootstrapOptions = {}): number {
  captureEnvironment();
  // Read now, not later: the GPU and X11 choices below are needed before the window exists.
  const settings = new SettingsService();
  applyGpuChoice(settings.get('integratedGpuOnly'));
  // Embedded DRM tabs need an X11 window (Wayland cannot embed another program's window).
  // GDK picks its backend when the display opens, which has not happened yet.
  if (embeddingRequested(settings.get('embedStreaming'), anyBrowserInstalled()))
    GLib.setenv('GDK_BACKEND', 'x11', true);
  const app = new Gtk.Application({
    // WEBSWITCH_APP_ID gives a run its own identity, so it does not join an open browser
    // (the tests and the benchmarks rely on it).
    application_id: options.appId ?? GLib.getenv('WEBSWITCH_APP_ID') ?? APP_ID,
    flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE,
  });
  let started: Promise<BrowserContext> | null = null;

  const ensureStarted = (): Promise<BrowserContext> => {
    if (started) return started;
    // The window only exists after some asynchronous setup; without this the app would quit first.
    app.hold();
    started = start(app, options, settings);
    started
      .catch((error: unknown) => {
        console.error(`${APP_NAME} could not start:`, error);
        app.quit();
      })
      .finally(() => {
        app.release();
      });
    return started;
  };

  app.connect('command-line', (_app, commandLine) => {
    const inputs = commandLine.get_arguments().slice(1);
    void ensureStarted().then((context) => {
      if (inputs.length > 0) openFromCommandLine(context, inputs);
      context.main.window.present();
    });
    return 0;
  });
  return app.run(
    System.programArgs.length > 0 ? [System.programInvocationName, ...System.programArgs] : [],
  );
}
