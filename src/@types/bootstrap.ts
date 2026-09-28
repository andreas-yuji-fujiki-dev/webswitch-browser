import type Gtk from 'gi://Gtk?version=4.0';
import type WebKit from 'gi://WebKit?version=6.0';
import type { IpcRouter } from '../main/core/ipc-router';
import type { MainWindow } from '../main/core/window';
import type { AccountService } from '../main/features/account/account.service';
import type { CookiesService } from '../main/features/cookies/cookies.service';
import type { DevToolsPanelService } from '../main/features/devtools/devtools-panel.service';
import type { DevToolsService } from '../main/features/devtools/devtools.service';
import type { HistoryService } from '../main/features/history/history.service';
import type { KeybindingsService } from '../main/features/keybindings/keybindings.service';
import type { MenuService } from '../main/features/menu/menu.service';
import type { NavigationService } from '../main/features/navigation/navigation.service';
import type { SettingsService } from '../main/features/settings/settings.service';
import type { BrowsersService } from '../main/features/browsers/browsers.service';
import type { ExtensionRuntime } from '../main/features/extensions/extension-runtime';
import type { ExtensionsService } from '../main/features/extensions/extensions.service';
import type { DrmService } from '../main/features/drm/drm.service';
import type { OpenVsx } from '../main/features/themes/openvsx';
import type { ThemesService } from '../main/features/themes/themes.service';
import type { ShortcutsService } from '../main/features/shortcuts/shortcuts.service';
import type { TabsService } from '../main/features/tabs/tabs.service';
import type { UserCssService } from '../main/features/user-css/user-css.service';

/** Everything that was built at startup, handed to `onReady` (the self-test drives the browser with it). */
export interface BrowserContext {
  app: Gtk.Application;
  main: MainWindow;
  ui: WebKit.WebView;
  router: IpcRouter;
  session: WebKit.NetworkSession;
  menuView: WebKit.WebView;
  tabs: TabsService;
  navigation: NavigationService;
  shortcuts: ShortcutsService;
  keybindings: KeybindingsService;
  history: HistoryService;
  userCss: UserCssService;
  account: AccountService;
  cookies: CookiesService;
  settings: SettingsService;
  browsers: BrowsersService;
  extensions: ExtensionsService;
  extensionRuntime: ExtensionRuntime;
  drm: DrmService;
  themes: ThemesService;
  openVsx: OpenVsx;
  devtools: DevToolsService;
  devtoolsPanel: DevToolsPanelService;
  menu: MenuService;
}

export interface BootstrapOptions {
  /** Another application id lets a test run next to a browser that is already open. */
  appId?: string;
  onReady?: (context: BrowserContext) => void | Promise<void>;
}
