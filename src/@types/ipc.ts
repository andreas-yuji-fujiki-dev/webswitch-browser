import type { IPC_CHANNELS } from '~shared/ipc-channels';
import type { AccountState } from './account';
import type {
  Bookmark,
  BookmarkChanges,
  BookmarkFolder,
  BookmarkOrderEntry,
  BookmarkPopupKind,
  BookmarksState,
} from './bookmarks';
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
import type { WindowControlsState } from './window';
import type { TabsState } from './tabs';

/** Renderer -> main requests (ipcRenderer.invoke / ipcMain.handle). */
export interface IpcInvokeMap {
  [IPC_CHANNELS.tabs.getState]: { args: []; result: TabsState };
  [IPC_CHANNELS.tabs.create]: { args: []; result: void };
  [IPC_CHANNELS.tabs.close]: { args: [tabId: number]; result: void };
  [IPC_CHANNELS.tabs.activate]: { args: [tabId: number]; result: void };
  [IPC_CHANNELS.tabs.setChromeHeight]: { args: [heightPx: number]; result: void };
  [IPC_CHANNELS.tabs.openHttpStatus]: { args: [status: number]; result: void };
  [IPC_CHANNELS.tabs.setPinned]: { args: [tabId: number, pinned: boolean]; result: void };
  [IPC_CHANNELS.tabs.setMuted]: { args: [tabId: number, muted: boolean]; result: void };
  /** The strip's new order, every tab id once; the native side still groups pinned tabs first
   * regardless of what is sent (it stays the single source of truth for that rule). */
  [IPC_CHANNELS.tabs.reorder]: { args: [order: number[]]; result: void };
  [IPC_CHANNELS.ui.setTitleBarLayout]: {
    args: [dragStartX: number, heightPx: number];
    result: void;
  };
  [IPC_CHANNELS.navigation.navigate]: { args: [input: string]; result: void };
  [IPC_CHANNELS.navigation.goBack]: { args: []; result: void };
  [IPC_CHANNELS.navigation.goForward]: { args: []; result: void };
  [IPC_CHANNELS.navigation.reload]: { args: []; result: void };
  [IPC_CHANNELS.navigation.stop]: { args: []; result: void };
  [IPC_CHANNELS.menu.toggle]: { args: []; result: void };
  [IPC_CHANNELS.menu.close]: { args: []; result: void };
  [IPC_CHANNELS.menu.select]: { args: [itemId: MenuItemId]; result: void };
  [IPC_CHANNELS.account.get]: { args: []; result: AccountState };
  [IPC_CHANNELS.history.query]: { args: [search: string, limit: number]; result: HistoryEntry[] };
  [IPC_CHANNELS.history.remove]: { args: [visitedAt: number]; result: void };
  [IPC_CHANNELS.history.clear]: { args: []; result: void };
  [IPC_CHANNELS.bookmarks.get]: { args: []; result: BookmarksState };
  [IPC_CHANNELS.bookmarks.add]: {
    args: [url: string, title: string, folderId: string | null];
    result: Bookmark;
  };
  [IPC_CHANNELS.bookmarks.update]: { args: [id: string, changes: BookmarkChanges]; result: void };
  [IPC_CHANNELS.bookmarks.remove]: { args: [id: string]; result: void };
  [IPC_CHANNELS.bookmarks.addFolder]: {
    args: [title: string, parentId: string | null];
    result: BookmarkFolder;
  };
  [IPC_CHANNELS.bookmarks.renameFolder]: { args: [id: string, title: string]; result: void };
  [IPC_CHANNELS.bookmarks.removeFolder]: { args: [id: string]; result: void };
  [IPC_CHANNELS.bookmarks.reorderBar]: { args: [order: BookmarkOrderEntry[]]; result: void };
  [IPC_CHANNELS.bookmarks.openPopup]: {
    args: [
      kind: BookmarkPopupKind,
      itemId: string | null,
      x: number,
      y: number,
      width: number,
      height: number,
    ];
    result: void;
  };
  [IPC_CHANNELS.bookmarks.closePopup]: { args: []; result: void };
  [IPC_CHANNELS.cookies.get]: { args: []; result: CookiesState };
  [IPC_CHANNELS.cookies.summary]: { args: []; result: CookiesSummary };
  [IPC_CHANNELS.cookies.remove]: { args: [ids: string[]]; result: void };
  [IPC_CHANNELS.cookies.setPolicy]: { args: [ids: string[], policy: CookiePolicy]; result: void };
  [IPC_CHANNELS.cookies.setCompanyPolicy]: {
    args: [company: string, policy: CookiePolicy];
    result: void;
  };
  [IPC_CHANNELS.cookies.openAccountPanel]: { args: [company: string]; result: void };
  [IPC_CHANNELS.keybindings.get]: { args: []; result: KeybindingsState };
  [IPC_CHANNELS.keybindings.set]: {
    args: [actionId: ShortcutActionId, accelerators: string[]];
    result: KeybindingResult;
  };
  [IPC_CHANNELS.keybindings.reset]: { args: [actionId: ShortcutActionId]; result: void };
  [IPC_CHANNELS.keybindings.resetAll]: { args: []; result: void };
  [IPC_CHANNELS.keybindings.setRecording]: { args: [recording: boolean]; result: void };
  [IPC_CHANNELS.settings.get]: { args: []; result: SettingsState };
  [IPC_CHANNELS.settings.set]: {
    args: [id: SettingId, value: SettingValue];
    result: SettingResult;
  };
  [IPC_CHANNELS.settings.reset]: { args: [id: SettingId]; result: void };
  [IPC_CHANNELS.settings.resetAll]: { args: []; result: void };
  [IPC_CHANNELS.settings.restart]: { args: []; result: void };
  [IPC_CHANNELS.extensions.get]: { args: []; result: ExtensionsState };
  [IPC_CHANNELS.extensions.prepareStore]: { args: [input: string]; result: ExtensionResult };
  [IPC_CHANNELS.extensions.prepareFolder]: { args: [path: string]; result: ExtensionResult };
  [IPC_CHANNELS.extensions.chooseFolder]: { args: []; result: ExtensionResult | null };
  [IPC_CHANNELS.extensions.confirm]: { args: []; result: ExtensionResult };
  [IPC_CHANNELS.extensions.cancel]: { args: []; result: ExtensionResult };
  [IPC_CHANNELS.extensions.setEnabled]: {
    args: [id: string, enabled: boolean];
    result: ExtensionResult;
  };
  [IPC_CHANNELS.extensions.remove]: { args: [id: string]; result: ExtensionResult };
  [IPC_CHANNELS.extensions.openPopup]: {
    args: [id: string, x: number, y: number, width: number, height: number];
    result: void;
  };
  [IPC_CHANNELS.extensions.openOptions]: { args: [id: string]; result: void };
  [IPC_CHANNELS.extensions.openStore]: { args: []; result: void };
  [IPC_CHANNELS.extensions.clearProxy]: { args: []; result: void };
  [IPC_CHANNELS.browsers.get]: { args: []; result: BrowsersState };
  [IPC_CHANNELS.browsers.check]: { args: []; result: BrowserResult };
  [IPC_CHANNELS.browsers.install]: {
    args: [id: BrowserId, version?: string];
    result: BrowserResult;
  };
  [IPC_CHANNELS.browsers.uninstall]: {
    args: [id: BrowserId, version: string];
    result: BrowserResult;
  };
  [IPC_CHANNELS.browsers.use]: { args: [id: BrowserId, version: string]; result: BrowserResult };
  [IPC_CHANNELS.browsers.open]: { args: [id: BrowserId]; result: BrowserResult };
  [IPC_CHANNELS.browsers.setStreaming]: { args: [choice: string]; result: BrowserResult };
  [IPC_CHANNELS.themes.get]: { args: []; result: ThemesState };
  [IPC_CHANNELS.themes.select]: { args: [id: string]; result: ThemeResult };
  [IPC_CHANNELS.themes.add]: { args: [json: string]; result: ThemeResult };
  [IPC_CHANNELS.themes.importFile]: { args: []; result: ThemeResult | null };
  [IPC_CHANNELS.themes.searchVsx]: {
    args: [query: string, offset: number, sort: VsxSort];
    result: VsxSearchAnswer;
  };
  [IPC_CHANNELS.themes.installVsx]: {
    args: [namespace: string, name: string];
    result: VsxInstallResult;
  };
  [IPC_CHANNELS.themes.installPopular]: { args: [count: number]; result: VsxInstallResult };
  [IPC_CHANNELS.themes.remove]: { args: [id: string]; result: ThemeResult };
  [IPC_CHANNELS.devtools.get]: { args: []; result: DevToolsState };
  [IPC_CHANNELS.devtools.use]: { args: [id: DevToolsProviderId]; result: DevToolsResult };
  [IPC_CHANNELS.devtools.check]: { args: []; result: DevToolsResult };
  [IPC_CHANNELS.devtools.download]: {
    args: [id: DevToolsProviderId, version?: string];
    result: DevToolsResult;
  };
  [IPC_CHANNELS.devtools.uninstall]: { args: [id: DevToolsProviderId]; result: DevToolsResult };
  [IPC_CHANNELS.userCss.get]: { args: []; result: string };
}

/** Main -> renderer events (webContents.send / ipcRenderer.on). Payload is the value itself. */
export interface IpcEventMap {
  [IPC_CHANNELS.tabs.stateChanged]: TabsState;
  [IPC_CHANNELS.ui.focusAddressBar]: null;
  [IPC_CHANNELS.ui.windowControls]: WindowControlsState;
  [IPC_CHANNELS.menu.stateChanged]: MenuState;
  [IPC_CHANNELS.account.changed]: AccountState;
  [IPC_CHANNELS.bookmarks.changed]: BookmarksState;
  [IPC_CHANNELS.bookmarks.shortcut]: null;
  [IPC_CHANNELS.history.changed]: null;
  [IPC_CHANNELS.cookies.changed]: null;
  [IPC_CHANNELS.keybindings.changed]: KeybindingsState;
  [IPC_CHANNELS.settings.changed]: SettingsState;
  [IPC_CHANNELS.devtools.changed]: DevToolsState;
  [IPC_CHANNELS.themes.changed]: ThemesState;
  [IPC_CHANNELS.browsers.changed]: BrowsersState;
  [IPC_CHANNELS.extensions.changed]: ExtensionsState;
  [IPC_CHANNELS.userCss.changed]: string;
}

export type InvokeChannel = keyof IpcInvokeMap;
export type InvokeArgs<C extends InvokeChannel> = IpcInvokeMap[C]['args'];
export type InvokeResult<C extends InvokeChannel> = IpcInvokeMap[C]['result'];

export type EventChannel = keyof IpcEventMap;
export type EventPayload<C extends EventChannel> = IpcEventMap[C];
