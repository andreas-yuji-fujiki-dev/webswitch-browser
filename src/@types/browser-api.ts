import type { AccountState } from './account';
import type { CookiePolicy, CookiesState } from './cookies';
import type { HistoryEntry } from './history';
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
    /** Opens the menu under the given corner, or closes it if it is open. */
    toggle: (anchorRight: number, anchorBottom: number) => Promise<void>;
    close: () => Promise<void>;
    /** The menu view reports its own size so the main process can fit the overlay to it. */
    setSize: (width: number, height: number) => Promise<void>;
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
