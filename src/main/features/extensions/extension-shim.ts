/**
 * The `chrome.*` API an extension sees, written as JavaScript that is injected before its own
 * scripts. `kind` is `content` for a content script (an isolated world in a page) and `page` for the
 * extension's own pages (background, popup, options), which get more of the API. Every call that
 * needs the browser goes through one message handler, `wsext_<id>`, that only that extension can see.
 */

import type { ShimConfig } from '~types/extensions';

export function buildShim(config: ShimConfig): string {
  return `(() => {
  // JSC here has no Symbol.dispose/Symbol.asyncDispose (the "using" resource-management proposal):
  // confirmed with typeof Symbol.dispose === 'undefined' in a bare WebView. Angular's own bundle
  // (Bitwarden's popup, at least) feature-detects this and throws "Symbol.dispose is not defined"
  // instead of using the real "using" syntax, so just giving it the well-known symbols is enough to
  // pass the check — nothing here needs the syntax itself, only the symbols to exist. Defined before
  // the __wsExt guard so it still runs even if this page's shim was already injected once.
  if (typeof Symbol.dispose === 'undefined') Symbol.dispose = Symbol.for('Symbol.dispose');
  if (typeof Symbol.asyncDispose === 'undefined')
    Symbol.asyncDispose = Symbol.for('Symbol.asyncDispose');
  if (self.__wsExt) return;
  const CONFIG = ${JSON.stringify(config)};
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers['wsext_' + CONFIG.id];
  const call = (op, payload) => {
    if (!handler) return Promise.reject(new Error('The extension API is not available here.'));
    return handler.postMessage(JSON.stringify(Object.assign({ op }, payload))).then((text) => (text === undefined || text === null || text === '' ? undefined : JSON.parse(text)));
  };
  // chrome.* functions take a callback or return a promise, like Chrome's.
  const api = (fn) => (...args) => {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      args.pop();
      fn(...args).then((value) => { chrome.runtime.lastError = undefined; last(value); }, (error) => { chrome.runtime.lastError = { message: String(error && error.message || error) }; last(); chrome.runtime.lastError = undefined; });
      return undefined;
    }
    return fn(...args);
  };
  const event = () => {
    const listeners = new Set();
    return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), hasListener: (fn) => listeners.has(fn), hasListeners: () => listeners.size > 0, _fire: (...args) => { for (const fn of [...listeners]) { try { fn(...args); } catch (e) { console.error(e); } } }, _listeners: listeners };
  };
  const url = (path) => CONFIG.base + String(path || '').replace(/^\\//, '');
  const messages = CONFIG.messages || {};
  const getMessage = (key, subs) => {
    if (key === '@@extension_id') return CONFIG.id;
    if (key === '@@ui_locale') return (CONFIG.language || 'en').replace('-', '_');
    if (key === '@@bidi_dir') return 'ltr';
    const entry = messages[key] || messages[String(key).toLowerCase()];
    if (!entry || typeof entry.message !== 'string') return '';
    const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
    return entry.message.replace(/\\$(\\d)/g, (_all, n) => (list[Number(n) - 1] === undefined ? '' : String(list[Number(n) - 1])))
      .replace(/\\$([A-Za-z0-9_@]+)\\$/g, (_all, name) => { const p = entry.placeholders && (entry.placeholders[name] || entry.placeholders[name.toLowerCase()]); return p ? String(p.content).replace(/\\$(\\d)/g, (_a, n) => (list[Number(n) - 1] === undefined ? '' : String(list[Number(n) - 1]))) : ''; });
  };

  const onMessage = event();
  const onConnect = event();
  // Ports (chrome.runtime.connect): an id chosen here names the port on both sides.
  const ports = new Map();
  const closePort = (portId) => {
    const port = ports.get(portId);
    if (!port) return;
    ports.delete(portId);
    port.onDisconnect._fire(port);
  };
  const makePort = (portId, name, sender) => {
    const port = {
      name,
      sender,
      onMessage: event(),
      onDisconnect: event(),
      postMessage: (message) => {
        if (!ports.has(portId)) throw new Error('Attempting to use a disconnected port object');
        call('port.post', { portId, message }).catch(() => undefined);
      },
      disconnect: () => {
        if (ports.delete(portId)) call('port.disconnect', { portId }).catch(() => undefined);
      },
    };
    ports.set(portId, port);
    return port;
  };
  const connectPort = (args, tabId) => {
    let info = {};
    for (const arg of args) if (arg && typeof arg === 'object') info = arg;
    const portId = CONFIG.id + ':' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const port = makePort(portId, info.name || '', undefined);
    call('port.connect', { portId, name: info.name || '', tabId }).catch(() => closePort(portId));
    return port;
  };
  // Native messaging: a program on this computer that named this extension. A failure to start is
  // reported late, like a program that could not be started: an extension that retries must not spin.
  const nativePorts = new Map();
  const closeNative = (portId, message) => {
    const port = nativePorts.get(portId);
    if (!port) return;
    nativePorts.delete(portId);
    chrome.runtime.lastError = message ? { message } : undefined;
    port.onDisconnect._fire(port);
    chrome.runtime.lastError = undefined;
  };
  const connectNative = (name) => {
    const portId = CONFIG.id + ':n:' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const port = {
      name,
      onMessage: event(),
      onDisconnect: event(),
      postMessage: (message) => {
        if (!nativePorts.has(portId)) throw new Error('Attempting to use a disconnected port object');
        call('native.post', { portId, message }).catch(() => undefined);
      },
      disconnect: () => {
        if (nativePorts.delete(portId)) call('native.disconnect', { portId }).catch(() => undefined);
      },
    };
    nativePorts.set(portId, port);
    call('native.connect', { portId, name }).catch((error) => {
      setTimeout(() => closeNative(portId, String((error && error.message) || error)), 1000);
    });
    return port;
  };
  const storageChanged = event();
  const area = (name) => ({
    get: api((keys) => call('storage.get', { area: name, keys: keys === undefined ? null : keys })),
    set: api((items) => call('storage.set', { area: name, items })),
    remove: api((keys) => call('storage.remove', { area: name, keys })),
    clear: api(() => call('storage.clear', { area: name })),
    getBytesInUse: api(() => Promise.resolve(0)),
    setAccessLevel: api(() => Promise.resolve()),
    onChanged: event(),
  });

  const chrome = self.chrome || {};
  chrome.runtime = {
    id: CONFIG.id,
    lastError: undefined,
    getURL: url,
    getManifest: () => CONFIG.manifest,
    getPlatformInfo: api(() => Promise.resolve({ os: 'linux', arch: 'x86-64', nacl_arch: 'x86-64' })),
    sendMessage: api((...args) => {
      const payload = args.length >= 2 && typeof args[0] === 'string' && /^[a-p]{32}$/.test(args[0]) ? args[1] : args[0];
      return call('runtime.sendMessage', { message: payload });
    }),
    onMessage,
    onMessageExternal: event(),
    onConnect,
    onInstalled: event(),
    onStartup: event(),
    onSuspend: event(),
    OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
    PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
    PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64' },
    ContextType: { TAB: 'TAB', POPUP: 'POPUP', BACKGROUND: 'BACKGROUND', OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT', SIDE_PANEL: 'SIDE_PANEL' },
    connect: (...args) => connectPort(args, null),
    connectNative,
    sendNativeMessage: api((name, message) => call('native.send', { name, message }).catch((error) => new Promise((_resolve, reject) => setTimeout(() => reject(error), 1000)))),
    setUninstallURL: api(() => Promise.resolve()),
    requestUpdateCheck: api(() => Promise.resolve({ status: 'no_update' })),
    getContexts: api(() => Promise.resolve([])),
    reload: () => location.reload(),
    openOptionsPage: api(() => call('runtime.openOptionsPage', {})),
  };
  chrome.extension = {
    getURL: url,
    inIncognitoContext: false,
    isAllowedIncognitoAccess: api(() => Promise.resolve(false)),
    isAllowedFileSchemeAccess: api(() => Promise.resolve(false)),
    getExtensionTabs: () => [],
  };
  chrome.i18n = {
    getMessage,
    getUILanguage: () => CONFIG.language || 'en',
    getAcceptLanguages: api(() => Promise.resolve(CONFIG.languages && CONFIG.languages.length > 0 ? CONFIG.languages : ['en'])),
    detectLanguage: api(() => Promise.resolve({ isReliable: false, languages: [] })),
  };
  const local = area('local');
  chrome.storage = { local, sync: area('sync'), session: area('session'), managed: area('managed'), onChanged: storageChanged };

  // A pattern such as "*://*.example.com/*" against an address (only what webRequest filters need).
  const escapeText = (text) => { let out = ''; for (const ch of text) out += '.+?^()|[]{}$\\\\'.includes(ch) ? '\\\\' + ch : ch; return out; };
  const patternMatches = (pattern, address) => {
    if (pattern === '<all_urls>') return /^(https?|wss?|ftp|file):/.test(address);
    const found = /^(\\*|[a-z][a-z0-9+.-]*):\\/\\/([^/]*)(\\/.*)$/i.exec(pattern);
    const parts = /^([a-z][a-z0-9+.-]*):\\/\\/([^/:?#]*)(?::\\d+)?([^#]*)$/i.exec(address);
    if (!found || !parts) return false;
    if (found[1] !== '*' ? found[1].toLowerCase() !== parts[1].toLowerCase() : !/^https?$/i.test(parts[1])) return false;
    const host = found[2];
    if (host !== '*') {
      const wanted = host.replace(/^\\*\\./, '').toLowerCase();
      const actual = parts[2].toLowerCase();
      if (host.startsWith('*.') ? actual !== wanted && !actual.endsWith('.' + wanted) : actual !== wanted) return false;
    }
    const path = found[3].split('*').map(escapeText).join('.*');
    return new RegExp('^' + path + '$').test(parts[3] === '' ? '/' : parts[3]);
  };
  const filterAllows = (filter, details) => {
    if (!filter) return true;
    if (filter.urls && !filter.urls.some((pattern) => patternMatches(pattern, details.url))) return false;
    if (filter.types && !filter.types.includes(details.type)) return false;
    return true;
  };

  if (CONFIG.kind === 'page') {
    // webRequest events only travel to an extension that listens; a blocking listener is remembered as such.
    const listenOn = (name) => {
      const ev = event();
      const add = ev.addListener;
      ev.addListener = (fn, filter, extra) => {
        const blocking = Array.isArray(extra) && (extra.includes('blocking') || extra.includes('asyncBlocking'));
        fn.__ws = { filter, blocking };
        add(fn);
        call('webRequest.listen', { name, blocking }).catch(() => undefined);
      };
      return ev;
    };
    // An event that only travels to an extension that listens (the browser is told when somebody does).
    const subscribable = (name) => {
      const ev = event();
      const add = ev.addListener;
      ev.addListener = (fn) => { add(fn); call('events.listen', { name }).catch(() => undefined); };
      return ev;
    };
    const fail = (text) => api(() => Promise.reject(new Error(text)));
    chrome.tabs = {
      query: api((query) => call('tabs.query', { query: query || {} })),
      get: api((id) => call('tabs.get', { id })),
      getCurrent: api(() => Promise.resolve(undefined)),
      getSelected: api(() => call('tabs.query', { query: { active: true } }).then((tabs) => tabs[0])),
      connect: (tabId, info) => connectPort([info || {}], tabId),
      getZoom: api(() => Promise.resolve(1)),
      setZoom: api(() => Promise.resolve()),
      detectLanguage: api(() => Promise.resolve('und')),
      create: api((props) => call('tabs.create', { props: props || {} })),
      duplicate: api((id) => call('tabs.duplicate', { id })),
      update: api((...args) => call('tabs.update', args.length >= 2 ? { id: args[0], props: args[1] } : { id: null, props: args[0] })),
      move: api((ids) => call('tabs.query', { query: {} }).then((tabs) => tabs.filter((tab) => [].concat(ids).includes(tab.id)))),
      highlight: api(() => Promise.resolve({ id: 1, focused: true, state: 'normal', type: 'normal', incognito: false })),
      discard: api(() => Promise.resolve(undefined)),
      remove: api((ids) => call('tabs.remove', { ids: Array.isArray(ids) ? ids : [ids] })),
      reload: api((id) => call('tabs.reload', { id: typeof id === 'number' ? id : null })),
      goBack: api((id) => call('tabs.go', { id: typeof id === 'number' ? id : null, direction: -1 })),
      goForward: api((id) => call('tabs.go', { id: typeof id === 'number' ? id : null, direction: 1 })),
      sendMessage: api((id, message) => call('tabs.sendMessage', { id, message })),
      sendRequest: api((id, message) => call('tabs.sendMessage', { id, message })),
      captureVisibleTab: api((...args) => call('tabs.captureVisibleTab', { options: args.find((arg) => arg && typeof arg === 'object') || {} })),
      executeScript: api((...args) => call('tabs.executeScript', typeof args[0] === 'number' ? { id: args[0], details: args[1] || {} } : { id: null, details: args[0] || {} })),
      insertCSS: api((...args) => call('tabs.insertCSS', typeof args[0] === 'number' ? { id: args[0], details: args[1] || {} } : { id: null, details: args[0] || {} })),
      removeCSS: api(() => Promise.resolve()),
      TAB_ID_NONE: -1,
      TabStatus: { LOADING: 'loading', COMPLETE: 'complete', UNLOADED: 'unloaded' },
      WindowType: { NORMAL: 'normal', POPUP: 'popup', PANEL: 'panel', APP: 'app', DEVTOOLS: 'devtools' },
      onUpdated: event(), onCreated: event(), onRemoved: event(), onActivated: event(),
    };
    chrome.windows = {
      getCurrent: api((info) => call('windows.getCurrent', { info: info || {} })),
      getAll: api((info) => call('windows.getAll', { info: info || {} })),
      getLastFocused: api((info) => call('windows.getLastFocused', { info: info || {} })),
      get: api((id, info) => call('windows.get', { id, info: info || {} })),
      create: api((props) => call('windows.create', { props: props || {} })),
      update: api((id, props) => call('windows.update', { id, props: props || {} })),
      remove: api((id) => call('windows.remove', { id })),
      WINDOW_ID_CURRENT: -2, WINDOW_ID_NONE: -1,
      WindowState: { NORMAL: 'normal', MINIMIZED: 'minimized', MAXIMIZED: 'maximized', FULLSCREEN: 'fullscreen', LOCKED_FULLSCREEN: 'locked-fullscreen' },
      WindowType: { NORMAL: 'normal', POPUP: 'popup', PANEL: 'panel', APP: 'app', DEVTOOLS: 'devtools' },
      onFocusChanged: event(), onCreated: event(), onRemoved: event(),
    };
    chrome.webNavigation = {
      onBeforeNavigate: event(), onCommitted: event(), onDOMContentLoaded: event(), onCompleted: event(),
      onHistoryStateUpdated: event(), onErrorOccurred: event(), onCreatedNavigationTarget: event(), onReferenceFragmentUpdated: event(),
      getAllFrames: api((details) => call('webNavigation.getAllFrames', { details: details || {} })),
      getFrame: api(() => Promise.resolve(null)),
    };
    // Requests can be watched (URL, headers, status), not blocked or changed: WebKit gives no hook for that.
    chrome.webRequest = {
      onBeforeRequest: listenOn('onBeforeRequest'), onBeforeSendHeaders: listenOn('onBeforeSendHeaders'), onSendHeaders: listenOn('onSendHeaders'),
      onHeadersReceived: listenOn('onHeadersReceived'), onAuthRequired: listenOn('onAuthRequired'), onResponseStarted: listenOn('onResponseStarted'),
      onBeforeRedirect: listenOn('onBeforeRedirect'), onCompleted: listenOn('onCompleted'), onErrorOccurred: listenOn('onErrorOccurred'),
      handlerBehaviorChanged: api(() => Promise.resolve()), MAX_HANDLER_BEHAVIOR_CHANGED_CALLS: 20,
      OnBeforeRequestOptions: { BLOCKING: 'blocking', REQUEST_BODY: 'requestBody', EXTRA_HEADERS: 'extraHeaders' },
      OnBeforeSendHeadersOptions: { BLOCKING: 'blocking', REQUEST_HEADERS: 'requestHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnSendHeadersOptions: { REQUEST_HEADERS: 'requestHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnHeadersReceivedOptions: { BLOCKING: 'blocking', RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders', SECURITY_INFO: 'securityInfo' },
      OnAuthRequiredOptions: { BLOCKING: 'blocking', RESPONSE_HEADERS: 'responseHeaders', ASYNC_BLOCKING: 'asyncBlocking', EXTRA_HEADERS: 'extraHeaders' },
      OnResponseStartedOptions: { RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders', SECURITY_INFO: 'securityInfo' },
      OnBeforeRedirectOptions: { RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' },
      OnCompletedOptions: { RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders', SECURITY_INFO: 'securityInfo' },
      ResourceType: { MAIN_FRAME: 'main_frame', SUB_FRAME: 'sub_frame', STYLESHEET: 'stylesheet', SCRIPT: 'script', IMAGE: 'image', FONT: 'font', OBJECT: 'object', XMLHTTPREQUEST: 'xmlhttprequest', PING: 'ping', CSP_REPORT: 'csp_report', MEDIA: 'media', WEBSOCKET: 'websocket', OTHER: 'other' },
    };
    chrome.cookies = {
      get: api((details) => call('cookies.get', { details })),
      getAll: api((details) => call('cookies.getAll', { details: details || {} })),
      set: api((details) => call('cookies.set', { details })),
      remove: api((details) => call('cookies.remove', { details })),
      getAllCookieStores: api(() => Promise.resolve([{ id: '0', tabIds: [] }])),
      onChanged: subscribable('cookies.onChanged'),
    };
    chrome.history = {
      search: api((query) => call('history.search', { query: query || {} })),
      getVisits: api((details) => call('history.getVisits', { details })),
      addUrl: api(() => Promise.resolve()), deleteUrl: api(() => Promise.resolve()), deleteRange: api(() => Promise.resolve()), deleteAll: api(() => Promise.resolve()),
      onVisited: subscribable('history.onVisited'), onVisitRemoved: event(),
    };
    // Webswitch has no bookmarks: the tree is empty and nothing can be added.
    chrome.bookmarks = {
      getTree: api(() => Promise.resolve([{ id: '0', title: '', children: [] }])),
      get: api(() => Promise.resolve([])), getChildren: api(() => Promise.resolve([])), getRecent: api(() => Promise.resolve([])), getSubTree: api(() => Promise.resolve([])), search: api(() => Promise.resolve([])),
      create: fail('Webswitch has no bookmarks.'), update: fail('Webswitch has no bookmarks.'), move: fail('Webswitch has no bookmarks.'), remove: fail('Webswitch has no bookmarks.'),
      onCreated: event(), onRemoved: event(), onChanged: event(), onMoved: event(),
    };
    chrome.downloads = {
      download: api((options) => call('downloads.download', { options })),
      search: api((query) => call('downloads.search', { query: query || {} })),
      pause: fail('Downloads cannot be paused in Webswitch.'), resume: fail('Downloads cannot be resumed in Webswitch.'),
      cancel: api((id) => call('downloads.cancel', { id })),
      erase: api((query) => call('downloads.erase', { query: query || {} })),
      open: api((id) => call('downloads.open', { id })), show: api((id) => call('downloads.show', { id })), showDefaultFolder: api(() => call('downloads.show', {})),
      setShelfEnabled: () => undefined, acceptDanger: api(() => Promise.resolve()), removeFile: api(() => Promise.resolve()),
      getFileIcon: api(() => Promise.resolve('')), setUiOptions: api(() => Promise.resolve()),
      onCreated: event(), onChanged: event(), onErased: event(), onDeterminingFilename: event(),
    };
    chrome.management = {
      getSelf: api(() => call('management.getSelf', {})),
      getAll: api(() => call('management.getAll', {})),
      get: api((id) => call('management.get', { id })),
      setEnabled: fail('An extension cannot turn extensions on or off here.'),
      onInstalled: event(), onUninstalled: event(), onEnabled: event(), onDisabled: event(),
    };
    chrome.identity = {
      getRedirectURL: (path) => 'https://' + CONFIG.id + '.chromiumapp.org/' + String(path || '').replace(/^\\//, ''),
      launchWebAuthFlow: api((details) => call('identity.auth', { details: details || {} })),
      getAuthToken: fail('chrome.identity.getAuthToken needs a Google account of the browser, which Webswitch does not have.'),
      removeCachedAuthToken: api(() => Promise.resolve()),
      getProfileUserInfo: api(() => Promise.resolve({ email: '', id: '' })),
      onSignInChanged: event(),
    };
    chrome.declarativeContent = {
      onPageChanged: Object.assign(event(), { addRules: (rules, cb) => { if (typeof cb === 'function') cb(rules); }, removeRules: (ids, cb) => { if (typeof cb === 'function') cb(); }, getRules: (ids, cb) => { if (typeof cb === 'function') cb([]); } }),
      PageStateMatcher: function (options) { Object.assign(this, options); },
      ShowAction: function () {}, ShowPageAction: function () {}, SetIcon: function () {}, RequestContentScript: function () {},
    };
    chrome.userScripts = {
      register: api((scripts) => call('userScripts.register', { scripts })),
      update: api((scripts) => call('userScripts.update', { scripts })),
      unregister: api((filter) => call('userScripts.unregister', { filter: filter || {} })),
      getScripts: api((filter) => call('userScripts.getScripts', { filter: filter || {} })),
      configureWorld: api((options) => call('userScripts.configureWorld', { options: options || {} })),
      getWorldConfigurations: api(() => call('userScripts.getWorldConfigurations', {})),
      resetWorldConfiguration: api(() => call('userScripts.resetWorldConfiguration', {})),
      ExecutionWorld: { MAIN: 'MAIN', USER_SCRIPT: 'USER_SCRIPT' },
    };
    chrome.proxy = {
      settings: {
        get: api(() => call('proxy.get', {})),
        set: api((details) => call('proxy.set', { details })),
        clear: api(() => call('proxy.clear', {})),
        onChange: event(),
      },
      onProxyError: event(),
    };
    chrome.browsingData = {
      remove: api((options, data) => call('browsingData.remove', { options: options || {}, data: data || {} })),
      removeCache: api((options) => call('browsingData.remove', { options: options || {}, data: { cache: true } })),
      removeCookies: api((options) => call('browsingData.remove', { options: options || {}, data: { cookies: true } })),
      removeHistory: api((options) => call('browsingData.remove', { options: options || {}, data: { history: true } })),
      removeLocalStorage: api((options) => call('browsingData.remove', { options: options || {}, data: { localStorage: true } })),
      removeIndexedDB: api((options) => call('browsingData.remove', { options: options || {}, data: { indexedDB: true } })),
      removeDownloads: api(() => Promise.resolve()), removeFormData: api(() => Promise.resolve()), removePasswords: api(() => Promise.resolve()),
      removeServiceWorkers: api((options) => call('browsingData.remove', { options: options || {}, data: { serviceWorkers: true } })),
      removeCacheStorage: api(() => Promise.resolve()), removeFileSystems: api(() => Promise.resolve()), removeWebSQL: api(() => Promise.resolve()), removePluginData: api(() => Promise.resolve()), removeAppcache: api(() => Promise.resolve()),
      settings: api(() => Promise.resolve({ options: {}, dataToRemove: {}, dataRemovalPermitted: {} })),
    };
    chrome.sessions = {
      getRecentlyClosed: api((filter) => call('sessions.getRecentlyClosed', { filter: filter || {} })),
      getDevices: api(() => Promise.resolve([])),
      restore: api((id) => call('sessions.restore', { id })),
      MAX_SESSION_RESULTS: 25,
      onChanged: event(),
    };
    chrome.power = { requestKeepAwake: (level) => { call('power.keepAwake', { level }).catch(() => undefined); }, releaseKeepAwake: () => { call('power.release', {}).catch(() => undefined); } };
    chrome.search = { query: api((info) => call('search.query', { info: info || {} })), Disposition: { CURRENT_TAB: 'CURRENT_TAB', NEW_TAB: 'NEW_TAB', NEW_WINDOW: 'NEW_WINDOW' } };
    chrome.tabGroups = {
      query: api(() => Promise.resolve([])), get: fail('Webswitch has no tab groups.'), update: fail('Webswitch has no tab groups.'), move: fail('Webswitch has no tab groups.'),
      TAB_GROUP_ID_NONE: -1, onCreated: event(), onUpdated: event(), onMoved: event(), onRemoved: event(),
    };
    chrome.tabs.group = fail('Webswitch has no tab groups.');
    chrome.tabs.ungroup = api(() => Promise.resolve());
    chrome.sidePanel = { setOptions: api(() => Promise.resolve()), setPanelBehavior: api(() => Promise.resolve()), getPanelBehavior: api(() => Promise.resolve({ openPanelOnActionClick: false })), open: fail('Webswitch has no side panel.') };
    chrome.tts = { speak: api(() => Promise.resolve()), stop: () => undefined, isSpeaking: api(() => Promise.resolve(false)), getVoices: api(() => Promise.resolve([])), onEvent: event() };
    chrome.system = { cpu: { getInfo: api(() => Promise.resolve({ numOfProcessors: navigator.hardwareConcurrency || 1, archName: 'x86_64', modelName: '', features: [], processors: [] })) }, memory: { getInfo: api(() => Promise.resolve({ capacity: 0, availableCapacity: 0 })) }, display: { getInfo: api(() => Promise.resolve([])) } };
    chrome.idle = { queryState: api(() => Promise.resolve('active')), setDetectionInterval: () => undefined, onStateChanged: event() };
    chrome.offscreen = {
      createDocument: api((parameters) => call('offscreen.create', { parameters: parameters || {} })),
      closeDocument: api(() => call('offscreen.close', {})),
      hasDocument: api(() => call('offscreen.has', {})),
      Reason: { TESTING: 'TESTING', AUDIO_PLAYBACK: 'AUDIO_PLAYBACK', IFRAME_SCRIPTING: 'IFRAME_SCRIPTING', DOM_SCRAPING: 'DOM_SCRAPING', BLOBS: 'BLOBS', DOM_PARSER: 'DOM_PARSER', USER_MEDIA: 'USER_MEDIA', DISPLAY_MEDIA: 'DISPLAY_MEDIA', WEB_RTC: 'WEB_RTC', CLIPBOARD: 'CLIPBOARD', LOCAL_STORAGE: 'LOCAL_STORAGE', WORKERS: 'WORKERS', BATTERY_STATUS: 'BATTERY_STATUS', MATCH_MEDIA: 'MATCH_MEDIA', GEOLOCATION: 'GEOLOCATION' },
    };
    chrome.runtime.getContexts = api((filter) => call('runtime.getContexts', { filter: filter || {} }));
    const setting = () => ({ get: api(() => Promise.resolve({ value: false, levelOfControl: 'controllable_by_this_extension' })), set: api(() => Promise.resolve()), clear: api(() => Promise.resolve()), onChange: event() });
    chrome.privacy = { services: { autofillAddressEnabled: setting(), autofillCreditCardEnabled: setting(), passwordSavingEnabled: setting(), autofillEnabled: setting() }, network: { webRTCIPHandlingPolicy: setting() }, websites: {} };
    chrome.extension.getBackgroundPage = () => null;
    chrome.extension.getViews = () => [];
    chrome.runtime.getBackgroundPage = api(() => Promise.resolve(undefined));
    chrome.scripting = {
      executeScript: api((injection) => call('scripting.executeScript', { injection: Object.assign({}, injection, { func: injection && typeof injection.func === 'function' ? String(injection.func) : undefined }) })),
      insertCSS: api((injection) => call('scripting.insertCSS', { injection })),
      removeCSS: api((injection) => call('scripting.removeCSS', { injection })),
      registerContentScripts: api((scripts) => call('scripting.register', { scripts })),
      updateContentScripts: api((scripts) => call('scripting.update', { scripts })),
      unregisterContentScripts: api((filter) => call('scripting.unregister', { filter: filter || {} })),
      getRegisteredContentScripts: api((filter) => call('scripting.getRegistered', { filter: filter || {} })),
      ExecutionWorld: { ISOLATED: 'ISOLATED', MAIN: 'MAIN' },
      StyleOrigin: { AUTHOR: 'AUTHOR', USER: 'USER' },
    };
    const action = {
      setBadgeText: api((details) => call('action.setText', { value: details && details.text || '' })),
      getBadgeText: api(() => call('action.getText', {})),
      setBadgeBackgroundColor: api((details) => call('action.setColor', { value: details && details.color })),
      setBadgeTextColor: api(() => Promise.resolve()),
      getBadgeBackgroundColor: api(() => call('action.getColor', {})),
      setTitle: api((details) => call('action.setTitle', { value: details && details.title || '' })),
      getTitle: api(() => call('action.getTitle', {})),
      setIcon: api((details) => call('action.setIcon', { value: details && details.path })),
      setPopup: api((details) => call('action.setPopup', { value: details && details.popup || '' })),
      getPopup: api(() => call('action.getPopup', {})),
      enable: api(() => Promise.resolve()), disable: api(() => Promise.resolve()), isEnabled: api(() => Promise.resolve(true)),
      openPopup: api(() => Promise.resolve()),
      onClicked: event(),
    };
    chrome.action = action;
    chrome.browserAction = action;
    chrome.pageAction = Object.assign({ show: api(() => Promise.resolve()), hide: api(() => Promise.resolve()) }, action);
    // Timers do what alarms do: the background page of an extension stays loaded. Like Chrome, nothing fires
    // sooner than 30 seconds (an extension that asks for less would otherwise spin), and when is honored.
    const alarms = new Map();
    const alarmEvent = event();
    const MIN_ALARM = 30000;
    const alarmObject = (name, entry) => Object.assign({ name, scheduledTime: entry.at }, entry.period ? { periodInMinutes: entry.period } : {});
    const clearAlarm = (name) => {
      const entry = alarms.get(name);
      if (!entry) return false;
      clearTimeout(entry.timer);
      alarms.delete(name);
      return true;
    };
    chrome.alarms = {
      create: api((...args) => {
        const name = typeof args[0] === 'string' ? args[0] : '';
        const info = (typeof args[0] === 'string' ? args[1] : args[0]) || {};
        clearAlarm(name);
        const now = Date.now();
        const first = info.when !== undefined ? info.when - now : info.delayInMinutes !== undefined ? info.delayInMinutes * 60000 : (info.periodInMinutes || 0) * 60000;
        const entry = { at: now + Math.max(first, MIN_ALARM), period: info.periodInMinutes };
        const fire = () => {
          const snapshot = alarmObject(name, entry);
          if (entry.period) {
            entry.at = Date.now() + Math.max(entry.period * 60000, MIN_ALARM);
            entry.timer = setTimeout(fire, entry.at - Date.now());
          } else {
            alarms.delete(name);
          }
          alarmEvent._fire(snapshot);
        };
        entry.timer = setTimeout(fire, entry.at - now);
        alarms.set(name, entry);
        return Promise.resolve();
      }),
      get: api((name) => Promise.resolve(alarms.has(name || '') ? alarmObject(name || '', alarms.get(name || '')) : undefined)),
      getAll: api(() => Promise.resolve([...alarms].map(([name, entry]) => alarmObject(name, entry)))),
      clear: api((name) => Promise.resolve(clearAlarm(name || ''))),
      clearAll: api(() => { const any = alarms.size > 0; for (const name of [...alarms.keys()]) clearAlarm(name); return Promise.resolve(any); }),
      onAlarm: alarmEvent,
    };
    let menuCount = 0;
    chrome.contextMenus = {
      create: (props, cb) => {
        const id = props && props.id !== undefined ? props.id : 'ws-menu-' + (++menuCount);
        call('contextMenus.create', { props: Object.assign({}, props, { id }) }).then(
          () => { if (typeof cb === 'function') cb(); },
          (error) => { chrome.runtime.lastError = { message: String(error && error.message || error) }; if (typeof cb === 'function') cb(); chrome.runtime.lastError = undefined; },
        );
        return id;
      },
      update: api((id, props) => call('contextMenus.update', { id, props })),
      remove: api((id) => call('contextMenus.remove', { id })),
      removeAll: api(() => call('contextMenus.removeAll', {})),
      ACTION_MENU_TOP_LEVEL_LIMIT: 6,
      ContextType: { ALL: 'all', PAGE: 'page', FRAME: 'frame', SELECTION: 'selection', LINK: 'link', EDITABLE: 'editable', IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', LAUNCHER: 'launcher', BROWSER_ACTION: 'browser_action', PAGE_ACTION: 'page_action', ACTION: 'action' },
      ItemType: { NORMAL: 'normal', CHECKBOX: 'checkbox', RADIO: 'radio', SEPARATOR: 'separator' },
      onClicked: event(),
    };
    chrome.menus = chrome.contextMenus;
    chrome.notifications = {
      create: api((...args) => call('notifications.create', typeof args[0] === 'string' ? { id: args[0], options: args[1] } : { id: '', options: args[0] })),
      update: api(() => Promise.resolve(true)),
      clear: api((id) => call('notifications.clear', { id })),
      getAll: api(() => call('notifications.getAll', {})),
      getPermissionLevel: api(() => Promise.resolve('granted')),
      onClicked: event(), onClosed: event(), onButtonClicked: event(), onShowSettings: event(), onPermissionLevelChanged: event(),
    };
    chrome.permissions = {
      contains: api((request) => call('permissions.contains', { request: request || {} })),
      request: api((request) => call('permissions.request', { request: request || {} })),
      getAll: api(() => call('permissions.getAll', {})),
      remove: api((request) => call('permissions.remove', { request: request || {} })),
      onAdded: event(), onRemoved: event(),
    };
    chrome.commands = { getAll: api(() => call('commands.getAll', {})), onCommand: event() };
    chrome.declarativeNetRequest = {
      updateDynamicRules: api((options) => call('dnr.updateDynamic', { options: options || {} })),
      updateSessionRules: api((options) => call('dnr.updateSession', { options: options || {} })),
      getDynamicRules: api(() => call('dnr.getDynamic', {})),
      getSessionRules: api(() => call('dnr.getSession', {})),
      updateEnabledRulesets: api((options) => call('dnr.updateEnabledRulesets', { options: options || {} })),
      getEnabledRulesets: api(() => call('dnr.getEnabledRulesets', {})),
      getAvailableStaticRuleCount: api(() => Promise.resolve(300000)),
      getDisabledRuleIds: api(() => Promise.resolve([])),
      updateStaticRules: api(() => Promise.resolve()),
      isRegexSupported: api((options) => Promise.resolve({ isSupported: !!(options && options.regex) })),
      getMatchedRules: api(() => Promise.resolve({ rulesMatchedInfo: [] })),
      setExtensionActionOptions: api(() => Promise.resolve()),
      MAX_NUMBER_OF_DYNAMIC_RULES: 30000, MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000, GUARANTEED_MINIMUM_STATIC_RULES: 30000, MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
      RuleActionType: { BLOCK: 'block', ALLOW: 'allow', REDIRECT: 'redirect', UPGRADE_SCHEME: 'upgradeScheme', MODIFY_HEADERS: 'modifyHeaders', ALLOW_ALL_REQUESTS: 'allowAllRequests' },
      ResourceType: { MAIN_FRAME: 'main_frame', SUB_FRAME: 'sub_frame', SCRIPT: 'script', IMAGE: 'image', STYLESHEET: 'stylesheet', XMLHTTPREQUEST: 'xmlhttprequest', OTHER: 'other', FONT: 'font', MEDIA: 'media', PING: 'ping', WEBSOCKET: 'websocket', CSP_REPORT: 'csp_report', OBJECT: 'object' },
    };
    // Cross-origin fetches of an extension are allowed for the hosts it asked for: the browser makes them.
    const realFetch = self.fetch.bind(self);
    self.fetch = async (input, init) => {
      const request = new Request(input, init);
      const target = new URL(request.url, location.href);
      if (target.origin === location.origin || target.protocol === 'data:' || target.protocol === 'blob:') return realFetch(input, init);
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : btoa(String.fromCharCode(...new Uint8Array(await request.arrayBuffer())));
      const headers = {};
      request.headers.forEach((value, name) => { headers[name] = value; });
      const answer = await call('fetch', { url: target.href, method: request.method, headers, body });
      const bytes = Uint8Array.from(atob(answer.body), (c) => c.charCodeAt(0));
      const noBody = [101, 204, 205, 304].includes(answer.status);
      return new Response(noBody ? null : bytes, { status: answer.status, statusText: answer.statusText, headers: answer.headers });
    };
    self.importScripts = (...urls) => { for (const path of urls) { const request = new XMLHttpRequest(); request.open('GET', new URL(path, location.href).href, false); request.send(); (0, eval)(request.responseText + '\\n//# sourceURL=' + path); } };
    self.skipWaiting = () => Promise.resolve();
    self.clients = { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) };
  }

  // What the browser sends into this context: messages, and changes to storage.
  self.__wsExt = {
    portConnect(portId, name, sender) { onConnect._fire(makePort(portId, name, sender)); },
    portMessage(portId, message) { const port = ports.get(portId); if (port) port.onMessage._fire(message, port); },
    portDisconnect(portId) { closePort(portId); },
    // A user script sent a message (only when the extension turned messaging on for its world).
    userScriptMessage(callId, message, sender) {
      let answered = false;
      let waiting = false;
      const respond = (response) => { if (answered) return; answered = true; call('runtime.respond', { callId, response: response === undefined ? null : response, empty: response === undefined }); };
      for (const listener of [...chrome.runtime.onUserScriptMessage._listeners]) {
        let result;
        try { result = listener(message, sender, respond); } catch (error) { console.error(error); continue; }
        if (result === true) waiting = true;
        else if (result && typeof result.then === 'function') { waiting = true; result.then(respond, () => respond(undefined)); }
      }
      if (!answered && !waiting) respond(undefined);
    },
    // A page (or frame) is about to load: blocking onBeforeRequest listeners may cancel it or send it elsewhere.
    beforeRequest(callId, details) {
      let answered = false;
      let pending = 0;
      const respond = (response) => { if (answered) return; answered = true; call('runtime.respond', { callId, response: response === undefined ? null : response, empty: response === undefined }); };
      const consider = (result) => {
        if (result && (result.cancel === true || typeof result.redirectUrl === 'string')) respond(result);
        else if (--pending === 0) respond(undefined);
      };
      for (const listener of [...chrome.webRequest.onBeforeRequest._listeners]) {
        if (!listener.__ws || !listener.__ws.blocking || !filterAllows(listener.__ws.filter, details)) continue;
        pending++;
        let result;
        try { result = listener(details); } catch (error) { console.error(error); pending--; continue; }
        if (result && typeof result.then === 'function') result.then(consider, () => consider(undefined));
        else consider(result);
      }
      if (pending === 0 && !answered) respond(undefined);
    },
    // A site asked for a username and password: a listener may answer, at once or later, with credentials.
    authRequired(callId, details) {
      let answered = false;
      let waiting = false;
      const respond = (response) => { if (answered) return; answered = true; call('runtime.respond', { callId, response: response === undefined ? null : response, empty: response === undefined }); };
      for (const listener of [...chrome.webRequest.onAuthRequired._listeners]) {
        let result;
        try { result = listener(details, respond); } catch (error) { console.error(error); continue; }
        if (result && typeof result.then === 'function') { waiting = true; result.then(respond, () => respond(undefined)); }
        else if (result && result.authCredentials) respond(result);
        else if (listener.length >= 2) waiting = true;
      }
      if (!answered && !waiting) respond(undefined);
    },
    nativeMessage(portId, message) { const port = nativePorts.get(portId); if (port) port.onMessage._fire(message, port); },
    nativeClosed(portId, error) { closeNative(portId, error); },
    reportSize() { call('popup.size', { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }); },
    deliver(callId, message, sender) {
      let answered = false;
      let waiting = false;
      const respond = (response) => { if (answered) return; answered = true; call('runtime.respond', { callId, response: response === undefined ? null : response, empty: response === undefined }); };
      for (const listener of [...onMessage._listeners]) {
        let result;
        try { result = listener(message, sender, respond); } catch (error) { console.error(error); continue; }
        if (result === true) waiting = true;
        else if (result && typeof result.then === 'function') { waiting = true; result.then(respond, () => respond(undefined)); }
      }
      if (!answered && !waiting) respond(undefined);
    },
    storageChanged(changes, areaName) {
      storageChanged._fire(changes, areaName);
      const target = chrome.storage[areaName];
      if (target) target.onChanged._fire(changes);
    },
    fire(path, args) {
      const parts = path.split('.');
      let target = chrome;
      for (const part of parts) target = target && target[part];
      if (target && typeof target._fire === 'function') target._fire(...args);
    },
  };
  // An event an extension listens to that Webswitch never fires must not stop it: any unknown on-something is a silent event.
  const lenient = (target) => new Proxy(target, {
    get(object, key) {
      if (typeof key === 'string' && !(key in object) && /^on[A-Z]/.test(key)) object[key] = event();
      return object[key];
    },
  });
  for (const name of ['runtime', 'tabs', 'windows', 'webNavigation', 'action', 'browserAction', 'pageAction', 'alarms', 'contextMenus', 'notifications', 'permissions', 'commands', 'idle', 'storage', 'extension', 'privacy']) {
    if (chrome[name]) chrome[name] = lenient(chrome[name]);
  }
  self.chrome = chrome;
  if (!self.browser) self.browser = chrome;
})();`;
}

/**
 * What a user script sees of `chrome.*`: nothing, unless the extension turned messaging on for the
 * world its user scripts run in, and then only `runtime.sendMessage` (answered by the extension's
 * `runtime.onUserScriptMessage`), like in Chrome.
 */
export function buildUserShim(id: string, messaging: boolean): string {
  if (!messaging) return '';
  return (
    '(() => { if (self.__wsUser) return; self.__wsUser = true;' +
    " const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers['wsext_" +
    id +
    "_us'];" +
    " const send = (message) => handler ? handler.postMessage(JSON.stringify({ op: 'userscript.message', message })).then((text) => (text ? JSON.parse(text) : undefined)) : Promise.reject(new Error('Messaging is not on for user scripts.'));" +
    ' const chromeLike = { runtime: { id: ' +
    JSON.stringify(id) +
    ', sendMessage: (...args) => { const last = args[args.length - 1]; const message = args.length >= 2 && typeof args[1] !== "function" ? args[1] : args[0]; const answer = send(message); if (typeof last === "function") { answer.then((value) => last(value), () => last()); return undefined; } return answer; } } };' +
    ' self.chrome = chromeLike; self.browser = chromeLike; })();'
  );
}
