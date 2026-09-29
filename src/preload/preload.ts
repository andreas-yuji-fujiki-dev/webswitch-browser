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
    openHttpStatus: (status) => invoke(IPC_CHANNELS.tabs.openHttpStatus, status),
    setPinned: (tabId, pinned) => invoke(IPC_CHANNELS.tabs.setPinned, tabId, pinned),
    setMuted: (tabId, muted) => invoke(IPC_CHANNELS.tabs.setMuted, tabId, muted),
    reorder: (order) => invoke(IPC_CHANNELS.tabs.reorder, order),
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
    toggle: () => invoke(IPC_CHANNELS.menu.toggle),
    close: () => invoke(IPC_CHANNELS.menu.close),
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
  bookmarks: {
    get: () => invoke(IPC_CHANNELS.bookmarks.get),
    add: (url, title, folderId) => invoke(IPC_CHANNELS.bookmarks.add, url, title, folderId),
    update: (id, changes) => invoke(IPC_CHANNELS.bookmarks.update, id, changes),
    remove: (id) => invoke(IPC_CHANNELS.bookmarks.remove, id),
    addFolder: (title, parentId) => invoke(IPC_CHANNELS.bookmarks.addFolder, title, parentId),
    renameFolder: (id, title) => invoke(IPC_CHANNELS.bookmarks.renameFolder, id, title),
    removeFolder: (id) => invoke(IPC_CHANNELS.bookmarks.removeFolder, id),
    reorderBar: (order) => invoke(IPC_CHANNELS.bookmarks.reorderBar, order),
    openPopup: (kind, itemId, x, y, width, height) =>
      invoke(IPC_CHANNELS.bookmarks.openPopup, kind, itemId, x, y, width, height),
    closePopup: () => invoke(IPC_CHANNELS.bookmarks.closePopup),
    onShortcut: (listener) =>
      subscribe(IPC_CHANNELS.bookmarks.shortcut, () => {
        listener();
      }),
    onChanged: (listener) => subscribe(IPC_CHANNELS.bookmarks.changed, listener),
  },
  cookies: {
    get: () => invoke(IPC_CHANNELS.cookies.get),
    summary: () => invoke(IPC_CHANNELS.cookies.summary),
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
  settings: {
    get: () => invoke(IPC_CHANNELS.settings.get),
    set: (id, value) => invoke(IPC_CHANNELS.settings.set, id, value),
    reset: (id) => invoke(IPC_CHANNELS.settings.reset, id),
    resetAll: () => invoke(IPC_CHANNELS.settings.resetAll),
    restart: () => invoke(IPC_CHANNELS.settings.restart),
    onChanged: (listener) => subscribe(IPC_CHANNELS.settings.changed, listener),
  },
  extensions: {
    get: () => invoke(IPC_CHANNELS.extensions.get),
    prepareStore: (input) => invoke(IPC_CHANNELS.extensions.prepareStore, input),
    prepareFolder: (path) => invoke(IPC_CHANNELS.extensions.prepareFolder, path),
    chooseFolder: () => invoke(IPC_CHANNELS.extensions.chooseFolder),
    confirm: () => invoke(IPC_CHANNELS.extensions.confirm),
    cancel: () => invoke(IPC_CHANNELS.extensions.cancel),
    setEnabled: (id, enabled) => invoke(IPC_CHANNELS.extensions.setEnabled, id, enabled),
    remove: (id) => invoke(IPC_CHANNELS.extensions.remove, id),
    openPopup: (id, x, y, width, height) =>
      invoke(IPC_CHANNELS.extensions.openPopup, id, x, y, width, height),
    openOptions: (id) => invoke(IPC_CHANNELS.extensions.openOptions, id),
    openStore: () => invoke(IPC_CHANNELS.extensions.openStore),
    clearProxy: () => invoke(IPC_CHANNELS.extensions.clearProxy),
    onChanged: (listener) => subscribe(IPC_CHANNELS.extensions.changed, listener),
  },
  browsers: {
    get: () => invoke(IPC_CHANNELS.browsers.get),
    check: () => invoke(IPC_CHANNELS.browsers.check),
    install: (id, version) => invoke(IPC_CHANNELS.browsers.install, id, version),
    uninstall: (id, version) => invoke(IPC_CHANNELS.browsers.uninstall, id, version),
    use: (id, version) => invoke(IPC_CHANNELS.browsers.use, id, version),
    open: (id) => invoke(IPC_CHANNELS.browsers.open, id),
    setStreaming: (choice) => invoke(IPC_CHANNELS.browsers.setStreaming, choice),
    onChanged: (listener) => subscribe(IPC_CHANNELS.browsers.changed, listener),
  },
  themes: {
    get: () => invoke(IPC_CHANNELS.themes.get),
    select: (id) => invoke(IPC_CHANNELS.themes.select, id),
    add: (json) => invoke(IPC_CHANNELS.themes.add, json),
    importFile: () => invoke(IPC_CHANNELS.themes.importFile),
    searchVsx: (query, offset, sort) => invoke(IPC_CHANNELS.themes.searchVsx, query, offset, sort),
    installVsx: (namespace, name) => invoke(IPC_CHANNELS.themes.installVsx, namespace, name),
    installPopular: (count) => invoke(IPC_CHANNELS.themes.installPopular, count),
    remove: (id) => invoke(IPC_CHANNELS.themes.remove, id),
    onChanged: (listener) => subscribe(IPC_CHANNELS.themes.changed, listener),
  },
  devtools: {
    get: () => invoke(IPC_CHANNELS.devtools.get),
    use: (id) => invoke(IPC_CHANNELS.devtools.use, id),
    check: () => invoke(IPC_CHANNELS.devtools.check),
    download: (id, version) => invoke(IPC_CHANNELS.devtools.download, id, version),
    uninstall: (id) => invoke(IPC_CHANNELS.devtools.uninstall, id),
    onChanged: (listener) => subscribe(IPC_CHANNELS.devtools.changed, listener),
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
