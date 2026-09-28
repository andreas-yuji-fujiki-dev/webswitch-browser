import type Gio from 'gi://Gio?version=2.0';
import type WebKit from 'gi://WebKit?version=6.0';

/** The parts of a Chrome extension's manifest.json that Webswitch reads. */
export interface ExtensionManifest {
  manifest_version: number;
  name: string;
  version: string;
  description?: string;
  default_locale?: string;
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  commands?: Record<
    string,
    { suggested_key?: Record<string, string> | string; description?: string; global?: boolean }
  >;
  content_scripts?: ContentScriptEntry[];
  background?: {
    service_worker?: string;
    scripts?: string[];
    page?: string;
    type?: string;
    persistent?: boolean;
  };
  action?: ActionEntry;
  browser_action?: ActionEntry;
  page_action?: ActionEntry;
  options_page?: string;
  options_ui?: { page?: string };
  icons?: Record<string, string>;
  web_accessible_resources?: (string | { resources?: string[]; matches?: string[] })[];
  declarative_net_request?: {
    rule_resources?: { id?: string; enabled?: boolean; path?: string }[];
  };
}

export interface ContentScriptEntry {
  matches?: string[];
  exclude_matches?: string[];
  js?: string[];
  css?: string[];
  run_at?: 'document_start' | 'document_end' | 'document_idle';
  all_frames?: boolean;
  world?: 'ISOLATED' | 'MAIN';
}

export interface ActionEntry {
  default_popup?: string;
  default_icon?: string | Record<string, string>;
  default_title?: string;
}

/** What Webswitch tells the user about an extension before it is installed. */
export interface ExtensionSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  /** `all`: every website. `sites`: the ones in `hosts`. `none`: no page at all. */
  hostAccess: 'all' | 'sites' | 'none';
  hosts: string[];
  /** Permissions Webswitch can honor. */
  supported: string[];
  /** Permissions it cannot: the extension may run only in part. */
  unsupported: string[];
  /** Permissions Webswitch accepts and ignores (they do nothing here). */
  ignored: string[];
  hasBackground: boolean;
  hasPopup: boolean;
  /** A button next to the address bar (popup or click handler). */
  hasAction: boolean;
  hasOptions: boolean;
  contentScripts: number;
  /** True when it blocks or redirects (kept for the page; blocking works for pages, not for their scripts). */
  blocksRequests: boolean;
  /** What its permissions let it do, in plain words: shown in red before it is added. */
  risks: string[];
  /** The extension's icon as a data: URL, or null. */
  icon: string | null;
}

export type ExtensionResult = { ok: true; id: string } | { ok: false; error: string };

/** An extension that is installed, as the UI sees it. */
export interface InstalledExtension extends ExtensionSummary {
  enabled: boolean;
  /** Where it came from: the Chrome Web Store, or a folder the user loaded. */
  source: 'store' | 'folder';
  /** The button's text over the extension's icon (`chrome.action.setBadgeText`). */
  badge: string;
  badgeColor: string;
  /** The button's tooltip (`chrome.action.setTitle`), empty for the extension's name. */
  title: string;
  /** An icon the extension set for its button, as a data: URL. */
  actionIcon: string | null;
}

export interface ExtensionsState {
  /** The General settings switch: while off nothing here runs and nothing is installed. */
  enabled: boolean;
  extensions: InstalledExtension[];
  /** An extension fetched and waiting for the user to confirm what it may do. */
  pending: ExtensionSummary | null;
  /** An extension is sending the pages through a proxy: shown so it is never a surprise. */
  proxy: { extension: string; name: string; description: string } | null;
  /** What the store download or the install is doing. */
  busy: string | null;
}

/** `state.json` of one installed extension. */
export interface ExtensionMeta {
  version: 1;
  id: string;
  enabled: boolean;
  source: 'store' | 'folder';
  installedAt: number;
}

export interface CrxHeader {
  /** Where the zip starts. */
  zipOffset: number;
  /** The 16 bytes an extension id is made of (CRX3: signed by the developer's key). */
  crxId: Uint8Array | null;
  /** The developer's public keys the file is signed with (DER); their hash must be `crxId`. */
  publicKeys: Uint8Array[];
}

/** A match pattern taken apart. */
export interface CompiledPattern {
  schemes: string[];
  host: RegExp | null;
  path: RegExp;
}

/** A declarativeNetRequest rule (only what is converted). */
export interface DnrRule {
  id?: number;
  priority?: number;
  action?: {
    type?: string;
    redirect?: {
      url?: string;
      extensionPath?: string;
      regexSubstitution?: string;
      transform?: {
        scheme?: string;
        host?: string;
        port?: string;
        path?: string;
        query?: string;
        fragment?: string;
        username?: string;
        password?: string;
        queryTransform?: {
          removeParams?: string[];
          addOrReplaceParams?: { key: string; value: string; replaceOnly?: boolean }[];
        };
      };
    };
  };
  condition?: {
    excludedRequestDomains?: string[];
    urlFilter?: string;
    regexFilter?: string;
    isUrlFilterCaseSensitive?: boolean;
    resourceTypes?: string[];
    excludedResourceTypes?: string[];
    domainType?: string;
    domains?: string[];
    initiatorDomains?: string[];
    excludedDomains?: string[];
    excludedInitiatorDomains?: string[];
    requestDomains?: string[];
  };
}

/** A rule in WebKit's content blocker format. */
export interface BlockerRule {
  trigger: {
    'url-filter': string;
    'url-filter-is-case-sensitive'?: boolean;
    'resource-type'?: string[];
    'load-type'?: string[];
    'if-domain'?: string[];
    'unless-domain'?: string[];
  };
  action: { type: 'block' | 'ignore-previous-rules' | 'make-https' };
}

/** An installed extension with what the runtime needs. */
export interface LoadedExtension {
  summary: ExtensionSummary;
  manifest: ExtensionManifest;
  meta: ExtensionMeta;
  /** The unpacked files. */
  files: string;
  /** The `_locales/<default>/messages.json` of the extension. */
  messages: Record<string, { message?: string }>;
}

/** What the injected `chrome.*` shim is told about its extension. */
export interface ShimConfig {
  id: string;
  kind: 'content' | 'page';
  /** `webswitch-ext://<id>/` */
  base: string;
  /** The user's language (`pt-BR`) and the ones accepted in order, for `chrome.i18n`. */
  language?: string;
  languages?: string[];
  manifest: ExtensionManifest;
  messages: Record<
    string,
    { message?: string; placeholders?: Record<string, { content?: string }> }
  >;
}

/** A tab as an extension is allowed to see it. */
export interface TabBrief {
  id: number;
  url: string;
  title: string;
  active: boolean;
  index: number;
  windowId: number;
}

/** What the extension runtime needs from the browser's tabs and windows. */
export interface ExtensionHost {
  listTabs: () => TabBrief[];
  tabIdOf: (view: WebKit.WebView) => number | null;
  viewOf: (id: number) => WebKit.WebView | null;
  createTab: (url: string, activate: boolean) => number;
  activateTab: (id: number) => void;
  updateTab: (id: number, url: string) => void;
  closeTab: (id: number) => void;
  reloadTab: (id: number) => void;
  /** The addresses of tabs closed recently, newest first. */
  recentlyClosed: () => string[];
  /** Called whenever tabs were opened, closed or switched. */
  onTabsChanged: (listener: () => void) => void;
}

/** A call from an extension's script to the browser: an operation and its arguments. */
export interface ExtensionCall {
  op: string;
  [key: string]: unknown;
}

/** Where a call from an extension's script came from. */
export interface RuntimeSource {
  kind: 'content' | 'page' | 'userscript';
  view: WebKit.WebView;
}

/** What chrome.storage keeps for one extension, by area. */
export interface StorageAreas {
  local: Record<string, unknown>;
  sync: Record<string, unknown>;
  managed: Record<string, unknown>;
  session: Record<string, unknown>;
}

/** One end of a `chrome.runtime.connect` port: a view, and the script world the extension's code runs in. */
export interface PortEndpoint {
  view: WeakRef<WebKit.WebView>;
  world: string | null;
}

/** A port between two parts of an extension, kept until either side disconnects or goes away. */
export interface PortEntry {
  extension: string;
  origin: PortEndpoint;
  peers: PortEndpoint[];
  /** Settled when the other side has been told about the port (messages wait for it). */
  ready: Promise<void>;
}

/** What an extension changed about its toolbar button. */
export interface ActionState {
  badge: string;
  badgeColor: string;
  title: string;
  icon: string | null;
  /** A popup set with `chrome.action.setPopup`, replacing the manifest's. */
  popup: string | null;
}

/** A content script registered while running (`chrome.scripting.registerContentScripts`). */
export interface RegisteredScript {
  id: string;
  matches?: string[];
  excludeMatches?: string[];
  js?: string[];
  css?: string[];
  allFrames?: boolean;
  runAt?: 'document_start' | 'document_end' | 'document_idle';
  world?: 'ISOLATED' | 'MAIN';
  persistAcrossSessions?: boolean;
}

/** What declarativeNetRequest keeps per extension besides the manifest's own rulesets. */
export interface DnrState {
  /** Ids of the static rulesets that are on; `null` until the extension changed them (then the manifest's `enabled` flags rule). */
  enabledRulesets: string[] | null;
  dynamic: DnrRule[];
}

/** An item made with `chrome.contextMenus.create`. */
export interface MenuItemProps {
  id: string | number;
  title?: string;
  type?: 'normal' | 'checkbox' | 'radio' | 'separator';
  contexts?: string[];
  parentId?: string | number;
  visible?: boolean;
  enabled?: boolean;
  documentUrlPatterns?: string[];
  targetUrlPatterns?: string[];
}

/** What the runtime lends to the API parts that do not touch views. */
export interface ExtrasContext {
  /** Tells an extension's background page that something happened (an event of `chrome.*`). */
  fire: (extension: string, event: string, args: unknown[]) => void;
  /** Asks the user to allow an extension more permissions; true when they agree. */
  ask: (extension: LoadedExtension, permissions: string[], origins: string[]) => Promise<boolean>;
  /** The browser window's size, for `chrome.windows`. */
  windowSize: () => { width: number; height: number };
  /** The address a search for `text` goes to with the chosen search engine. */
  searchUrl: (text: string) => string;
}

/** What an API part answers: it handled the call (with a value), or it is not its call. */
export type ExtrasAnswer = { handled: false } | { handled: true; value: unknown };

/** What a right click was over. */
export interface MenuTarget {
  link: boolean;
  image: boolean;
  media: boolean;
  editable: boolean;
  selection: boolean;
  linkUrl: string;
  srcUrl: string;
}

/** A running program an extension is connected to (native messaging). */
export interface HostProcess {
  extension: string;
  process: Gio.Subprocess;
  stdin: Gio.OutputStream;
  stdout: Gio.InputStream;
  closing: boolean;
}

/** What a declarativeNetRequest rule decided about a page navigation. */
export type NavigationVerdict =
  { kind: 'redirect'; url: string } | { kind: 'block' } | { kind: 'allow' } | null;

/** What an extension answered to a blocking `webRequest.onBeforeRequest` on a navigation. */
export interface RequestVerdict {
  cancel?: boolean;
  redirectUrl?: string;
}

/** A script registered with `chrome.userScripts`. */
export interface UserScriptEntry {
  id: string;
  matches?: string[];
  excludeMatches?: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
  js?: { code?: string; file?: string }[];
  allFrames?: boolean;
  runAt?: 'document_start' | 'document_end' | 'document_idle';
  world?: 'USER_SCRIPT' | 'MAIN';
  worldId?: string;
}

/** How an extension configured the world its user scripts run in. */
export interface UserScriptWorld {
  messaging: boolean;
  csp?: string;
}

/** The proxy an extension set (`chrome.proxy.settings`), and who set it. */
export interface ProxyChoice {
  extension: string;
  value: Record<string, unknown>;
  /** A sentence for the user: where the traffic goes. */
  description: string;
}

/** A proxy server as `chrome.proxy` names it. */
export interface ProxyServer {
  scheme?: string;
  host?: string;
  port?: number;
}

/** A download as `chrome.downloads` describes it. */
export interface DownloadItem {
  id: number;
  url: string;
  finalUrl: string;
  filename: string;
  state: 'in_progress' | 'complete' | 'interrupted';
  bytesReceived: number;
  totalBytes: number;
  fileSize: number;
  startTime: string;
  endTime?: string;
  error?: string;
  byExtensionId?: string;
  mime: string;
  exists: boolean;
  paused: boolean;
  canResume: boolean;
  danger: string;
  incognito: boolean;
}
