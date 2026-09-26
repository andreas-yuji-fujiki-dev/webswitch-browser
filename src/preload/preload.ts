import { IPC_CHANNELS } from '~shared/ipc-channels';
import type { BrowserApi } from '~types/browser-api';
import type { Unsubscribe } from '~types/common';
import type {
  EventChannel,
  EventPayload,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
} from '~types/ipc';

// Runs in the browser UI's own page before its scripts. WebKit's `ipc` message handler (present only
// on the browser's own views) answers each call with a JSON string.
async function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<InvokeResult<C>> {
  const reply = await window.webkit.messageHandlers.ipc.postMessage({ channel, args });
  return JSON.parse(reply) as InvokeResult<C>;
}

const listeners = new Map<string, Set<(payload: never) => void>>();

// The native side delivers events by calling this (see IpcRouter.emit).
window.__wsEmit = (channel, payload) => {
  for (const listener of listeners.get(channel) ?? []) (listener as (p: unknown) => void)(payload);
};

function subscribe<C extends EventChannel>(
  channel: C,
  listener: (payload: EventPayload<C>) => void,
): Unsubscribe {
  const set = listeners.get(channel) ?? new Set();
  set.add(listener);
  listeners.set(channel, set);
  return () => {
    set.delete(listener);
  };
}

const browserApi: BrowserApi = {
  tabs: {
    getState: () => invoke(IPC_CHANNELS.tabs.getState),
    create: () => invoke(IPC_CHANNELS.tabs.create),
    close: (tabId) => invoke(IPC_CHANNELS.tabs.close, tabId),
    activate: (tabId) => invoke(IPC_CHANNELS.tabs.activate, tabId),
    setChromeHeight: (heightPx) => invoke(IPC_CHANNELS.tabs.setChromeHeight, heightPx),
    onStateChanged: (listener) => subscribe(IPC_CHANNELS.tabs.stateChanged, listener),
  },
  navigation: {
    navigate: (input) => invoke(IPC_CHANNELS.navigation.navigate, input),
    goBack: () => invoke(IPC_CHANNELS.navigation.goBack),
    goForward: () => invoke(IPC_CHANNELS.navigation.goForward),
    reload: () => invoke(IPC_CHANNELS.navigation.reload),
    stop: () => invoke(IPC_CHANNELS.navigation.stop),
  },
  ui: {
    onFocusAddressBar: (listener) =>
      subscribe(IPC_CHANNELS.ui.focusAddressBar, () => {
        listener();
      }),
    setTitleBarLayout: (dragStartX, heightPx) =>
      invoke(IPC_CHANNELS.ui.setTitleBarLayout, dragStartX, heightPx),
    onWindowControls: (listener) => subscribe(IPC_CHANNELS.ui.windowControls, listener),
  },
  menu: {
    toggle: (anchorRight, anchorBottom) =>
      invoke(IPC_CHANNELS.menu.toggle, anchorRight, anchorBottom),
    close: () => invoke(IPC_CHANNELS.menu.close),
    setSize: (width, height) => invoke(IPC_CHANNELS.menu.setSize, width, height),
    select: (itemId) => invoke(IPC_CHANNELS.menu.select, itemId),
    onStateChanged: (listener) => subscribe(IPC_CHANNELS.menu.stateChanged, listener),
  },
  account: {
    get: () => invoke(IPC_CHANNELS.account.get),
    onChanged: (listener) => subscribe(IPC_CHANNELS.account.changed, listener),
  },
  history: {
    query: (search, limit) => invoke(IPC_CHANNELS.history.query, search, limit),
    remove: (visitedAt) => invoke(IPC_CHANNELS.history.remove, visitedAt),
    clear: () => invoke(IPC_CHANNELS.history.clear),
    onChanged: (listener) =>
      subscribe(IPC_CHANNELS.history.changed, () => {
        listener();
      }),
  },
  cookies: {
    get: () => invoke(IPC_CHANNELS.cookies.get),
    remove: (ids) => invoke(IPC_CHANNELS.cookies.remove, ids),
    setPolicy: (ids, policy) => invoke(IPC_CHANNELS.cookies.setPolicy, ids, policy),
    setCompanyPolicy: (company, policy) =>
      invoke(IPC_CHANNELS.cookies.setCompanyPolicy, company, policy),
    openAccountPanel: (company) => invoke(IPC_CHANNELS.cookies.openAccountPanel, company),
    onChanged: (listener) =>
      subscribe(IPC_CHANNELS.cookies.changed, () => {
        listener();
      }),
  },
  keybindings: {
    get: () => invoke(IPC_CHANNELS.keybindings.get),
    set: (actionId, accelerators) => invoke(IPC_CHANNELS.keybindings.set, actionId, accelerators),
    reset: (actionId) => invoke(IPC_CHANNELS.keybindings.reset, actionId),
    resetAll: () => invoke(IPC_CHANNELS.keybindings.resetAll),
    setRecording: (recording) => invoke(IPC_CHANNELS.keybindings.setRecording, recording),
    onChanged: (listener) => subscribe(IPC_CHANNELS.keybindings.changed, listener),
  },
  userCss: {
    get: () => invoke(IPC_CHANNELS.userCss.get),
    onChanged: (listener) => subscribe(IPC_CHANNELS.userCss.changed, listener),
  },
};

window.browserApi = browserApi;
