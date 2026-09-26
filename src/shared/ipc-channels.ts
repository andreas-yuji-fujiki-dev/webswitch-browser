// Runtime constants shared by main, preload and renderer. No Electron imports allowed here.
// The payload contract for each channel lives in src/@types/ipc.ts.
export const IPC_CHANNELS = {
  tabs: {
    getState: 'tabs:get-state',
    create: 'tabs:create',
    close: 'tabs:close',
    activate: 'tabs:activate',
    setChromeHeight: 'tabs:set-chrome-height',
    stateChanged: 'tabs:state-changed',
  },
  navigation: {
    navigate: 'navigation:navigate',
    goBack: 'navigation:go-back',
    goForward: 'navigation:go-forward',
    reload: 'navigation:reload',
    stop: 'navigation:stop',
  },
  ui: {
    focusAddressBar: 'ui:focus-address-bar',
    setTitleBarLayout: 'ui:set-title-bar-layout',
    windowControls: 'ui:window-controls',
  },
  menu: {
    toggle: 'menu:toggle',
    close: 'menu:close',
    setSize: 'menu:set-size',
    select: 'menu:select',
    stateChanged: 'menu:state-changed',
  },
  account: {
    get: 'account:get',
    changed: 'account:changed',
  },
  history: {
    query: 'history:query',
    remove: 'history:remove',
    clear: 'history:clear',
    changed: 'history:changed',
  },
  cookies: {
    get: 'cookies:get',
    remove: 'cookies:remove',
    setPolicy: 'cookies:set-policy',
    setCompanyPolicy: 'cookies:set-company-policy',
    openAccountPanel: 'cookies:open-account-panel',
    changed: 'cookies:changed',
  },
  keybindings: {
    get: 'keybindings:get',
    set: 'keybindings:set',
    reset: 'keybindings:reset',
    resetAll: 'keybindings:reset-all',
    setRecording: 'keybindings:set-recording',
    changed: 'keybindings:changed',
  },
  userCss: {
    get: 'user-css:get',
    changed: 'user-css:changed',
  },
} as const;
