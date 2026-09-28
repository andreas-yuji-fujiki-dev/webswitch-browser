// State the content script asks for, so the self-test can check what the background page saw.
const state = {
  offscreen: null,
  contexts: null,
  downloadState: null,
  downloads: null,
  cleaned: null,
  closed: null,
  cookieChanged: 0,
  visited: 0,
  tabTitle: null,
  language: null,
  proxy: null,
  cancelled: 0,
  userMessage: null,
  native: null,
  nativeError: null,
  nativePort: null,
  nativeMissing: null,
  auth: 0,
  installed: null,
  navigated: null,
  requests: 0,
  alarms: 0,
  menu: null,
  command: null,
  registered: 0,
  dnr: 0,
  ownPage: null,
  ownPageTabId: null,
};

chrome.storage.local.set({ background: 'ran' });

chrome.runtime.onInstalled.addListener((details) => {
  state.installed = details.reason;
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message && message.type === 'ping') {
    respond({ pong: message.value, tab: sender.tab ? sender.tab.id : null });
    return;
  }
  if (message && message.type === 'own-page-loaded') {
    state.ownPage = 'loaded';
    return;
  }
  if (message && message.type === 'fetch') {
    // A cross-origin request: allowed because the manifest names this host.
    fetch(message.url)
      .then((answer) => answer.text())
      .then(
        (text) => respond({ length: text.length }),
        (error) => respond({ error: String(error) }),
      );
    return true;
  }
  if (message && message.type === 'status') {
    Promise.all([chrome.tabs.query({ currentWindow: true }), chrome.alarms.getAll()]).then(
      ([tabs, alarms]) => {
        respond(
          Object.assign({}, state, {
            tabs: tabs.length,
            tabHasStatus: tabs.every((tab) => typeof tab.status === 'string'),
            alarmCount: alarms.length,
          }),
        );
      },
    );
    return true;
  }
  if (message && message.type === 'cookie') {
    chrome.cookies
      .set({ url: message.url, name: 'ws', value: '1' })
      .then(() => chrome.cookies.getAll({ url: message.url }))
      .then(
        (cookies) =>
          respond({ count: cookies.length, names: cookies.map((cookie) => cookie.name) }),
        (error) => respond({ error: String(error) }),
      );
    return true;
  }
});

// A port from a content script: it answers every message on it.
chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((message) => port.postMessage({ echo: message, name: port.name }));
});

chrome.webNavigation.onCompleted.addListener((details) => {
  state.navigated = details.url;
});

chrome.webRequest.onCompleted.addListener(() => {
  state.requests++;
});

chrome.contextMenus.create({
  id: 'fixture-item',
  title: 'Fixture item',
  contexts: ['page', 'link'],
});
chrome.contextMenus.onClicked.addListener((info) => {
  state.menu = info.menuItemId + ' on ' + info.pageUrl;
});

chrome.commands.onCommand.addListener((name) => {
  state.command = name;
});

chrome.alarms.create('later', { when: Date.now() + 3600 * 1000 });
chrome.alarms.getAll().then((alarms) => {
  state.alarms = alarms.length;
});

chrome.scripting
  .registerContentScripts([
    {
      id: 'dynamic',
      matches: ['*://localhost/*', '*://127.0.0.1/*'],
      js: ['dyn.js'],
      runAt: 'document_end',
    },
  ])
  .then(
    () => {
      state.registered = 1;
    },
    () => {
      state.registered = 2;
    },
  );

chrome.declarativeNetRequest
  .updateDynamicRules({
    addRules: [
      {
        id: 2,
        priority: 1,
        action: { type: 'redirect', redirect: { url: 'http://localhost:8765/two.html' } },
        condition: { urlFilter: 'redirect-me.html', resourceTypes: ['main_frame'] },
      },
      {
        id: 1,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: 'blocked2.js', resourceTypes: ['script'] },
      },
    ],
    removeRuleIds: [1, 2],
  })
  .then(
    () => {
      state.dnr = 1;
    },
    () => {
      state.dnr = 2;
    },
  );

// Native messaging: a program the self-test announced for this extension.
chrome.runtime.sendNativeMessage('dev.webswitch.test', { hi: 'native' }).then(
  (reply) => {
    state.native = reply;
  },
  (error) => {
    state.nativeError = String((error && error.message) || error);
  },
);
const nativePort = chrome.runtime.connectNative('dev.webswitch.test');
nativePort.onMessage.addListener((message) => {
  state.nativePort = message;
});
nativePort.postMessage({ ping: 1 });
chrome.runtime.sendNativeMessage('dev.webswitch.absent', {}).catch((error) => {
  state.nativeMissing = String((error && error.message) || error);
});

// A site asks for a username and password: this extension keeps the login.
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    state.auth++;
    callback({ authCredentials: { username: 'user', password: 'pass' } });
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking'],
);

// A proxy for the pages (the self-test asks for it and lets go of it).
self.setProxy = () =>
  chrome.proxy.settings
    .set({
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: 'http', host: '127.0.0.1', port: 8798 },
          bypassList: ['localhost'],
        },
      },
      scope: 'regular',
    })
    .then(
      () => {
        state.proxy = 'set';
      },
      (error) => {
        state.proxy = String((error && error.message) || error);
      },
    );
self.clearProxy = () =>
  chrome.proxy.settings.clear({ scope: 'regular' }).then(() => {
    state.proxy = 'cleared';
  });

// Blocking a page before it loads.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.url.includes('cancel-me')) {
      state.cancelled++;
      return { cancel: true };
    }
    return {};
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['blocking'],
);

// A user script, in its own world, that can message this extension.
chrome.runtime.onUserScriptMessage.addListener((message, sender, respond) => {
  state.userMessage = message;
  respond({ ok: true });
});
chrome.userScripts
  .configureWorld({ messaging: true })
  .then(() =>
    chrome.userScripts.register([
      {
        id: 'us1',
        matches: ['*://localhost/*', '*://127.0.0.1/*'],
        js: [
          {
            code: 'document.documentElement.dataset.us = "yes"; chrome.runtime.sendMessage({ hello: "user" }).then((reply) => { document.documentElement.dataset.usReply = JSON.stringify(reply); });',
          },
        ],
        runAt: 'document_end',
        world: 'USER_SCRIPT',
      },
    ]),
  )
  .catch((error) => {
    state.userMessage = 'ERR ' + error;
  });

// Offscreen document, downloads, browsing data, closed tabs, language.
state.language = chrome.i18n.getUILanguage();
chrome.offscreen
  .createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'self-test' })
  .then(() => new Promise((resolve) => setTimeout(resolve, 1500)))
  .then(() => chrome.runtime.sendMessage({ type: 'to-offscreen' }))
  .then((reply) => {
    state.offscreen = reply;
  })
  .then(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT', 'BACKGROUND'] }))
  .then((contexts) => {
    state.contexts = contexts.map((context) => context.contextType);
  })
  .catch((error) => {
    state.offscreen = 'ERR ' + ((error && error.message) || error);
  });

chrome.downloads.onChanged.addListener((change) => {
  if (change.state && change.state.current) state.downloadState = change.state.current;
});
self.startDownload = () =>
  chrome.downloads
    .download({ url: 'http://localhost:8765/two.html' })
    .then(() => new Promise((resolve) => setTimeout(resolve, 1500)))
    .then(() => chrome.downloads.search({}))
    .then((list) => {
      state.downloads = list.length;
    });
self.clean = () =>
  chrome.browsingData.remove({}, { cache: true }).then(() => {
    state.cleaned = true;
  });
self.askClosed = () =>
  chrome.sessions.getRecentlyClosed({}).then((list) => {
    state.closed = list.length;
  });
// own-page.html is not in web_accessible_resources: opening it as a tab (not a background/popup/
// options view) checks that a tab may still load and render one of the extension's own pages when
// the extension itself asked for it, unlike a foreign page trying to reach the same file.
self.openOwnPage = () =>
  chrome.tabs.create({ url: chrome.runtime.getURL('own-page.html') }).then((tab) => {
    state.ownPageTabId = tab.id;
  });

chrome.cookies.onChanged.addListener(() => {
  state.cookieChanged++;
});
chrome.history.onVisited.addListener(() => {
  state.visited++;
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.title) state.tabTitle = info.title;
});
