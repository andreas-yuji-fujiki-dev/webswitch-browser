import type { IPC_CHANNELS } from '~shared/ipc-channels';
import type { AccountState } from './account';
import type { HistoryEntry } from './history';
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
  [IPC_CHANNELS.ui.setTitleBarLayout]: {
    args: [dragStartX: number, heightPx: number];
    result: void;
  };
  [IPC_CHANNELS.navigation.navigate]: { args: [input: string]; result: void };
  [IPC_CHANNELS.navigation.goBack]: { args: []; result: void };
  [IPC_CHANNELS.navigation.goForward]: { args: []; result: void };
  [IPC_CHANNELS.navigation.reload]: { args: []; result: void };
  [IPC_CHANNELS.navigation.stop]: { args: []; result: void };
  [IPC_CHANNELS.menu.toggle]: { args: [anchorRight: number, anchorBottom: number]; result: void };
  [IPC_CHANNELS.menu.close]: { args: []; result: void };
  [IPC_CHANNELS.menu.setSize]: { args: [width: number, height: number]; result: void };
  [IPC_CHANNELS.menu.select]: { args: [itemId: MenuItemId]; result: void };
  [IPC_CHANNELS.account.get]: { args: []; result: AccountState };
  [IPC_CHANNELS.history.query]: { args: [search: string, limit: number]; result: HistoryEntry[] };
  [IPC_CHANNELS.history.remove]: { args: [visitedAt: number]; result: void };
  [IPC_CHANNELS.history.clear]: { args: []; result: void };
  [IPC_CHANNELS.keybindings.get]: { args: []; result: KeybindingsState };
  [IPC_CHANNELS.keybindings.set]: {
    args: [actionId: ShortcutActionId, accelerators: string[]];
    result: KeybindingResult;
  };
  [IPC_CHANNELS.keybindings.reset]: { args: [actionId: ShortcutActionId]; result: void };
  [IPC_CHANNELS.keybindings.resetAll]: { args: []; result: void };
  [IPC_CHANNELS.keybindings.setRecording]: { args: [recording: boolean]; result: void };
  [IPC_CHANNELS.userCss.get]: { args: []; result: string };
}

/** Main -> renderer events (webContents.send / ipcRenderer.on). Payload is the value itself. */
export interface IpcEventMap {
  [IPC_CHANNELS.tabs.stateChanged]: TabsState;
  [IPC_CHANNELS.ui.focusAddressBar]: null;
  [IPC_CHANNELS.ui.windowControls]: WindowControlsState;
  [IPC_CHANNELS.menu.stateChanged]: MenuState;
  [IPC_CHANNELS.account.changed]: AccountState;
  [IPC_CHANNELS.history.changed]: null;
  [IPC_CHANNELS.keybindings.changed]: KeybindingsState;
  [IPC_CHANNELS.userCss.changed]: string;
}

export type InvokeChannel = keyof IpcInvokeMap;
export type InvokeArgs<C extends InvokeChannel> = IpcInvokeMap[C]['args'];
export type InvokeResult<C extends InvokeChannel> = IpcInvokeMap[C]['result'];

export type EventChannel = keyof IpcEventMap;
export type EventPayload<C extends EventChannel> = IpcEventMap[C];
