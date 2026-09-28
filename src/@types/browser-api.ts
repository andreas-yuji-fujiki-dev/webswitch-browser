import type { AccountState } from './account';
import type { CookiePolicy, CookiesState, CookiesSummary } from './cookies';
import type { HistoryEntry } from './history';
import type { BrowserId, BrowserResult, BrowsersState } from './browsers';
import type { ExtensionResult, ExtensionsState } from './extensions';
import type {
  ThemeResult,
  ThemesState,
  VsxInstallResult,
  VsxSearchAnswer,
  VsxSort,
} from './themes';
import type { DevToolsProviderId, DevToolsResult, DevToolsState } from './devtools';
import type { SettingId, SettingResult, SettingsState, SettingValue } from './settings';
import type { KeybindingResult, KeybindingsState, ShortcutActionId } from './keybindings';
import type { MenuItemId, MenuState } from './menu';
import type { TabsState } from './tabs';
import type { WindowControlsState } from './window';
import type { Unsubscribe } from './common';

/** The whole surface the preload exposes to the browser UI as `window.browserApi`. */
export interface BrowserApi {
  tabs: {
    getState: () => Promise<TabsState>;
    create: () => Promise<void>;
    close: (tabId: number) => Promise<void>;
    activate: (tabId: number) => Promise<void>;
    /** The UI reports how tall its chrome is; the main process lays the page views out below it. */
    setChromeHeight: (heightPx: number) => Promise<void>;
    /** Opens MDN's page for an HTTP status in a new tab, for the "see more" button on a load error. */
    openHttpStatus: (status: number) => Promise<void>;
    onStateChanged: (listener: (state: TabsState) => void) => Unsubscribe;
  };
  navigation: {
    navigate: (input: string) => Promise<void>;
    goBack: () => Promise<void>;
    goForward: () => Promise<void>;
    reload: () => Promise<void>;
    stop: () => Promise<void>;
  };
  ui: {
    onFocusAddressBar: (listener: () => void) => Unsubscribe;
    /**
     * The window has no title bar: empty space in the tab strip, from `dragStartX` (CSS px) to the
     * window controls, moves the window. The UI reports where that space starts and how tall it is.
     */
    setTitleBarLayout: (dragStartX: number, heightPx: number) => Promise<void>;
    onWindowControls: (listener: (state: WindowControlsState) => void) => Unsubscribe;
  };
  menu: {
    /** Opens the menu panel (half of the window; the page takes the other half), or closes it. */
    toggle: () => Promise<void>;
    close: () => Promise<void>;
    select: (itemId: MenuItemId) => Promise<void>;
    onStateChanged: (listener: (state: MenuState) => void) => Unsubscribe;
  };
  account: {
    get: () => Promise<AccountState>;
    onChanged: (listener: (state: AccountState) => void) => Unsubscribe;
  };
  history: {
    /** Newest first. An empty `search` returns everything, up to `limit`. */
    query: (search: string, limit: number) => Promise<HistoryEntry[]>;
    remove: (visitedAt: number) => Promise<void>;
    clear: () => Promise<void>;
    onChanged: (listener: () => void) => Unsubscribe;
  };
  cookies: {
    get: () => Promise<CookiesState>;
    /** Who is signed in and how many cookies there are, for the menu. */
    summary: () => Promise<CookiesSummary>;
    /** Deletes the cookies from the browser and from Webswitch's own copies. */
    remove: (ids: string[]) => Promise<void>;
    /** `active` restores a disabled or restricted cookie; the others take it out of the browser. */
    setPolicy: (ids: string[], policy: CookiePolicy) => Promise<void>;
    /**
     * One rule for every cookie of a company, including the ones it sets later: `disabled`, or
     * `only-on` some sites. `active` removes the rule. Cookies set individually keep their own rule.
     */
    setCompanyPolicy: (company: string, policy: CookiePolicy) => Promise<void>;
    /** Opens the account page of a known company (Google, Microsoft, ...) in a tab. */
    openAccountPanel: (company: string) => Promise<void>;
    onChanged: (listener: () => void) => Unsubscribe;
  };
  settings: {
    get: () => Promise<SettingsState>;
    /** The main process validates the value; a refused one comes back as an error message. */
    set: (id: SettingId, value: SettingValue) => Promise<SettingResult>;
    reset: (id: SettingId) => Promise<void>;
    resetAll: () => Promise<void>;
    /** Closes the browser and starts it again, reopening the pages that are open now. */
    restart: () => Promise<void>;
    onChanged: (listener: (state: SettingsState) => void) => Unsubscribe;
  };
  extensions: {
    get: () => Promise<ExtensionsState>;
    /** Downloads an extension from the Chrome Web Store (an address or an id) and waits for the user's confirmation. */
    prepareStore: (input: string) => Promise<ExtensionResult>;
    /** Loads an unpacked extension from a folder and waits for the user's confirmation. */
    prepareFolder: (path: string) => Promise<ExtensionResult>;
    /** Opens a folder chooser and prepares what is in it; null when the user cancelled. */
    chooseFolder: () => Promise<ExtensionResult | null>;
    /** The user accepted what the waiting extension may do. */
    confirm: () => Promise<ExtensionResult>;
    cancel: () => Promise<ExtensionResult>;
    setEnabled: (id: string, enabled: boolean) => Promise<ExtensionResult>;
    remove: (id: string) => Promise<ExtensionResult>;
    /** Opens the extension's popup under the toolbar button at this place (window coordinates). */
    openPopup: (id: string, x: number, y: number, width: number, height: number) => Promise<void>;
    openOptions: (id: string) => Promise<void>;
    /** Stops the proxy an extension set: the system's settings come back. */
    clearProxy: () => Promise<void>;
    onChanged: (listener: (state: ExtensionsState) => void) => Unsubscribe;
  };
  browsers: {
    get: () => Promise<BrowsersState>;
    /** Asks each vendor which releases exist (only when pressed). */
    check: () => Promise<BrowserResult>;
    /** Downloads and installs a release, the newest when none is named (only when asked). */
    install: (id: BrowserId, version?: string) => Promise<BrowserResult>;
    /** Deletes one installed release to free the space. */
    uninstall: (id: BrowserId, version: string) => Promise<BrowserResult>;
    /** Chooses the installed release that "Open this page in ..." uses. */
    use: (id: BrowserId, version: string) => Promise<BrowserResult>;
    /** Opens the current page in that browser, inside a tab. */
    open: (id: BrowserId) => Promise<BrowserResult>;
    /** Which browser plays Netflix, Spotify and the like: `system` or `chrome` / `edge`. */
    setStreaming: (choice: string) => Promise<BrowserResult>;
    onChanged: (listener: (state: BrowsersState) => void) => Unsubscribe;
  };
  themes: {
    get: () => Promise<ThemesState>;
    /** A theme id, or `system` for Webswitch's dark or light like the desktop. */
    select: (id: string) => Promise<ThemeResult>;
    /** Adds a theme from its JSON text; a refused one comes back as an error message. */
    add: (json: string) => Promise<ThemeResult>;
    /** Opens a file chooser and adds the theme in the file; null when the user cancelled. */
    importFile: () => Promise<ThemeResult | null>;
    /** Searches Open VSX (the open registry of VS Code extensions) for color themes; only when the user asks. */
    searchVsx: (query: string, offset: number, sort: VsxSort) => Promise<VsxSearchAnswer>;
    /** Downloads one extension and adds every color theme in it. */
    installVsx: (namespace: string, name: string) => Promise<VsxInstallResult>;
    /** Adds the themes of the most downloaded extensions that are not installed yet. */
    installPopular: (count: number) => Promise<VsxInstallResult>;
    /** Removes a theme that was added (the ones that ship with Webswitch stay). */
    remove: (id: string) => Promise<ThemeResult>;
    onChanged: (listener: (state: ThemesState) => void) => Unsubscribe;
  };
  devtools: {
    get: () => Promise<DevToolsState>;
    /** Makes an installed developer tools the one F12 opens. */
    use: (id: DevToolsProviderId) => Promise<DevToolsResult>;
    /** Asks the npm registry which releases exist (only when pressed; nothing is asked by itself). */
    check: () => Promise<DevToolsResult>;
    /** Downloads a release, the newest when none is named (only when asked). */
    download: (id: DevToolsProviderId, version?: string) => Promise<DevToolsResult>;
    /** Uninstalls Chrome DevTools (the built-in inspector cannot be removed). */
    uninstall: (id: DevToolsProviderId) => Promise<DevToolsResult>;
    onChanged: (listener: (state: DevToolsState) => void) => Unsubscribe;
  };
  keybindings: {
    get: () => Promise<KeybindingsState>;
    /** Replaces the accelerators of one action. Fails on invalid or already used combinations. */
    set: (actionId: ShortcutActionId, accelerators: string[]) => Promise<KeybindingResult>;
    reset: (actionId: ShortcutActionId) => Promise<void>;
    resetAll: () => Promise<void>;
    /** While recording, real shortcuts are suspended so the pressed keys do not trigger actions. */
    setRecording: (recording: boolean) => Promise<void>;
    onChanged: (listener: (state: KeybindingsState) => void) => Unsubscribe;
  };
  userCss: {
    get: () => Promise<string>;
    onChanged: (listener: (css: string) => void) => Unsubscribe;
  };
}
