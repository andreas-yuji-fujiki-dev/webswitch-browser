import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';
import System from 'system';
import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { BootstrapOptions, BrowserContext } from '~types/bootstrap';
import { APP_ID, APP_NAME, DEFAULT_SEARCH_ENGINE, UI_HOST, UI_SCHEME } from './config';
import { handleDownloads } from './downloads';
import { ensureDir, readText } from './files';
import { IpcRouter } from './ipc-router';
import { migrateLegacyData } from './legacy-migration';
import { cacheDir, configDir, dataDir, distDir } from './paths';
import { openPopupWindow } from './popup-window';
import { followSystemColorScheme, isDark } from './theme';
import { registerUiIpc } from './ui-ipc';
import { registerUiScheme } from './ui-scheme';
import { createTabView, createUiView } from './webviews';
import { MainWindow } from './window';
import { resolveInput } from '../features/navigation/url-resolver';
import { parseUrl } from './url';
import { registerAccountIpc } from '../features/account/account.ipc';
import { AccountService } from '../features/account/account.service';
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

async function start(app: Gtk.Application, options: BootstrapOptions): Promise<BrowserContext> {
  followSystemColorScheme();
  ensureDir(configDir());
  ensureDir(dataDir());
  ensureDir(cacheDir());
  await migrateLegacyData();

  const dist = distDir();
  registerUiScheme(GLib.build_filenamev([dist, 'renderer']));
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
  handleDownloads(session);
  // Spellcheck dictionaries would be downloaded from a server, so spellcheck stays off.
  WebKit.WebContext.get_default().set_spell_checking_enabled(false);

  const permissions = new PermissionsService();
  const router = new IpcRouter();
  const uiSession = WebKit.NetworkSession.new_ephemeral();
  const dark = isDark();
  const uiView = createUiView(
    { session: uiSession, router, preload },
    color(dark ? '#000000' : '#eff3bc'),
  );
  const menuView = createUiView(
    { session: uiSession, router, preload },
    color('rgba(0,0,0,0)'),
    uiView,
  );

  const main = new MainWindow(app, uiView);
  const focusUi = (): void => {
    uiView.grab_focus();
  };
  const focusAddressBar = (): void => {
    focusUi();
    router.emit(IPC_CHANNELS.ui.focusAddressBar, null);
  };

  const keybindings = new KeybindingsService();
  const history = new HistoryService();
  const userCss = new UserCssService();
  const account = new AccountService(session);
  const drm = new DrmService();
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
    createView: (related) => createTabView({ session, permissions, handOff: routeDrm }, related),
    focusAddressBar,
    focusUi,
    onPageVisit: (visit) => {
      history.record(visit);
    },
    handOff: routeDrm,
    needsDrm: (url) => drm.needsDrm(url),
    attachEmbed: (view, url) => embed?.attach(view, url) ?? null,
    openPopup: (view) => {
      openPopupWindow(main.window, view);
    },
    setContentFullscreen: (fullscreen) => {
      main.setContentFullscreen(fullscreen);
    },
  });
  const navigation = new NavigationService(tabs);
  const menu = new MenuService(main.overlay, menuView);
  const embed = embeddingAvailable()
    ? new EmbedService(
        main.window,
        () => drm.findBrowser(),
        () => menu.isOpen(),
      )
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

  registerTabsIpc(router, tabs);
  registerNavigationIpc(router, navigation);
  registerMenuIpc(router, menu);
  registerKeybindingsIpc(router, keybindings, shortcuts);
  registerHistoryIpc(router, history);
  registerAccountIpc(router, account);
  registerUserCssIpc(router, userCss);
  registerUiIpc(router, main);
  menu.onSelect((itemId) => {
    if (itemId === 'keybindings' || itemId === 'history') tabs.openPage(itemId);
    if (itemId === 'user') tabs.createTab(account.entryUrl());
  });

  // Keep the window title in sync with the active tab.
  tabs.onStateChanged((state) => {
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    main.window.set_title(active?.title ? `${active.title} — ${APP_NAME}` : APP_NAME);
  });
  app.connect('shutdown', () => {
    userCss.dispose();
  });

  await Promise.all([userCss.init(), keybindings.init(), history.init(), account.init()]);

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
    userCss,
    account,
    menu,
  };
  await options.onReady?.(context);
  return context;
}

/** What the user typed on the command line becomes tabs: the first fills a blank tab if that is all there is. */
function openFromCommandLine(context: BrowserContext, inputs: string[]): void {
  const urls = inputs
    .map((input) => resolveInput(input, DEFAULT_SEARCH_ENGINE))
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
  // Embedded DRM tabs need an X11 window (Wayland cannot embed another program's window).
  // GDK picks its backend when the display opens, which has not happened yet.
  if (embeddingRequested()) GLib.setenv('GDK_BACKEND', 'x11', true);
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
    started = start(app, options);
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
