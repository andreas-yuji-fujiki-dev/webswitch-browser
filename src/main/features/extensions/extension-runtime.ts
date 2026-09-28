import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import type Soup from 'gi://Soup?version=3.0';
import JavaScriptCore from 'gi://JavaScriptCore?version=6.0';
import WebKit from 'gi://WebKit?version=6.0';
import { hostsOf } from '~shared/extension-manifest';
import { matchesAny, toWebKitPatterns } from '~shared/match-pattern';
import { EXTENSION_SCHEME } from '../../core/config';
import { DEBUG, debug } from '../../core/debug';
import { writeText } from '../../core/files';
import type { Http } from '../../core/http';
import type { HistoryService } from '../history/history.service';
import { cacheDir, dataDir } from '../../core/paths';
import '../../core/webkit-async';
import { ExtensionDnr } from './extension-dnr';
import { commandShortcut, ExtensionExtras } from './extension-extras';
import { ExtensionMenus } from './extension-menus';
import { NativeHosts } from './extension-native';
import { ExtensionProxy } from './extension-proxy';
import { buildShim, buildUserShim } from './extension-shim';
import { ExtensionScripts } from './extension-scripts';
import { ExtensionUserScripts } from './extension-userscripts';
import type { ExtensionsService } from './extensions.service';
import type {
  ExtensionCall,
  ExtensionHost,
  LoadedExtension,
  MenuTarget,
  PortEndpoint,
  PortEntry,
  RegisteredScript,
  RequestVerdict,
  RuntimeSource,
  ShimConfig,
  StorageAreas,
  TabBrief,
} from '~types/extensions';

Gio._promisify(Gtk.AlertDialog.prototype, 'choose', 'choose_finish');

const MAX_SCRIPT_BYTES = 8_000_000;
const MAX_FETCH_BYTES = 60_000_000;
const ANSWER_TIMEOUT_S = 60;
const NAVIGATION_ANSWER_S = 4;
const SAVE_DELAY_MS = 300;
const POPUP_MAX = { width: 800, height: 600 };
const POPUP_MIN = { width: 120, height: 60 };
const EXEC_SCRIPT_TIMEOUT_MS = 5000;
const EXEC_SCRIPT_POLL_MS = 25;

const worldOf = (id: string): string => `ext-${id}`;
const userWorldOf = (id: string): string => `ext-${id}-us`;
const handlerOf = (id: string): string => `wsext_${id}`;
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });

/** Adds a <style> element with `css` as soon as the document has an element to hold it. */
const styleScript = (css: string): string =>
  `(() => { const put = () => { const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).append(style); };
  if (document.documentElement) put();
  else new MutationObserver((_records, observer) => { if (document.documentElement) { observer.disconnect(); put(); } }).observe(document, { childList: true }); })();`;

/** A test on the address that includeGlobs and excludeGlobs ask for, as JavaScript; null when there are none. */
const globGuard = (include?: string[], exclude?: string[]): string | null => {
  const test = (glob: string): string =>
    `new RegExp(${JSON.stringify(`^${glob.split('*').map(escapeRegex).join('.*')}$`)}).test(location.href)`;
  const parts: string[] = [];
  if (include && include.length > 0) parts.push(`(${include.map(test).join(' || ')})`);
  if (exclude && exclude.length > 0) parts.push(`!(${exclude.map(test).join(' || ')})`);
  return parts.length === 0 ? null : parts.join(' && ');
};

/** What kind of resource a request is, guessed from its address (WebKit does not say). */
const requestType = (url: string): string => {
  const path = /^[^?#]*/.exec(url)?.[0].toLowerCase() ?? '';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'script';
  if (path.endsWith('.css')) return 'stylesheet';
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(path)) return 'image';
  if (/\.(woff2?|ttf|otf)$/.test(path)) return 'font';
  if (/\.(mp4|webm|mp3|ogg|m4a|wav)$/.test(path)) return 'media';
  return 'xmlhttprequest';
};

const escapeRegex = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/**
 * Runs Chrome extensions in WebKit. Content scripts and styles are injected with WebKit's own
 * user-script API into a script world of their own per extension; the `chrome.*` API they see is a
 * shim (extension-shim.ts) that asks this class for everything that needs the browser: storage,
 * messages between the extension's parts, tabs, fetches for the hosts it declared. A background page
 * (a service worker is run as a page too) lives in a view that is never shown; a popup is a popover
 * with a view in it. The rules of a Manifest V3 extension (declarativeNetRequest) become WebKit
 * content blockers. While the General settings switch is off `service.active()` is empty, so nothing
 * here runs.
 */
export class ExtensionRuntime {
  private readonly attached = new Set<WeakRef<WebKit.WebView>>();
  private readonly watched = new WeakSet<WebKit.WebView>();
  private readonly ports = new Map<string, PortEntry>();
  private knownTabs = new Set<number>();
  private activeTab: number | null = null;
  private readonly registered = new WeakMap<WebKit.UserContentManager, Set<string>>();
  private readonly pageViews = new Map<WebKit.WebView, string>();
  /**
   * A tab (not a background/popup/options `pageView`) that is currently showing one of an active
   * extension's own pages, opened through `tabs.create`/`tabs.update` — not a foreign page's link or
   * redirect, which `decide-policy` still refuses (see `allowsTabNavigation`). Cleared once the tab
   * commits a navigation away from that extension's origin.
   */
  private readonly tabExtension = new WeakMap<WebKit.WebView, string>();
  /** Exact `webswitch-ext://` URLs a `tabs.create`/`tabs.update` call just asked for, one-time use. */
  private readonly pendingOwnNavigation = new Set<string>();
  private readonly backgrounds = new Map<string, { view: WebKit.WebView; loaded: Promise<void> }>();
  private readonly menus: ExtensionMenus;
  private readonly scripts: ExtensionScripts;
  private readonly dnr: ExtensionDnr;
  private readonly extras: ExtensionExtras;
  private readonly natives: NativeHosts;
  private readonly proxy: ExtensionProxy;
  private readonly tabSession: WebKit.NetworkSession;
  private readonly userScripts: ExtensionUserScripts;
  private readonly nativeOrigins = new Map<string, PortEndpoint>();
  /** Which webRequest events each extension listens to (they are only sent when somebody listens). */
  private readonly requestListeners = new Map<string, Set<string>>();
  private readonly blockingListeners = new Map<string, Set<string>>();
  private readonly lastRedirect = new WeakMap<WebKit.WebView, { url: string; at: number }>();
  private requestCount = 0;
  private requestSequence = 0;
  private userAgent: string | null = null;
  /** The user's languages as Chrome writes them (`pt-BR`), most wanted first. */
  private readonly languages = [
    ...new Set(
      GLib.get_language_names()
        .map((name) => (name.split('.')[0] ?? '').split('@')[0] ?? '')
        .filter((name) => /^[A-Za-z_-]{2,12}$/.test(name) && name !== 'C')
        .map((name) => name.replace('_', '-')),
    ),
  ];
  private readonly offscreens = new Map<string, WebKit.WebView>();
  private readonly eventListeners = new Map<string, Set<string>>();
  private tabDetails = new Map<number, { url: string; title: string }>();
  private known = new Set<string>();
  private readonly storage = new Map<string, StorageAreas>();
  private readonly storageTimers = new Set<string>();
  private readonly waiting = new Map<
    number,
    (answer: { response: unknown; empty: boolean }) => void
  >();
  private nextCall = 1;
  private network: WebKit.NetworkSession | null = null;
  private popover: Gtk.Popover | null = null;
  /** What was last put in place: the badge changes often and must not redo everything. */
  private applied = '';

  constructor(
    private readonly service: ExtensionsService,
    private readonly host: ExtensionHost,
    private readonly http: Http,
    /** A widget the popups point at (they open under the toolbar button). */
    private readonly anchor: Gtk.Widget,
    deps: {
      cookieManager: WebKit.CookieManager;
      allCookies: () => Promise<Soup.Cookie[]>;
      history: HistoryService;
      session: WebKit.NetworkSession;
      app: Gtk.Application;
      searchUrl: (text: string) => string;
    },
  ) {
    this.menus = new ExtensionMenus(service, (id, info, view) => {
      const tabId = this.host.tabIdOf(view);
      const tab = this.host.listTabs().find((item) => item.id === tabId);
      this.fireIn(id, 'contextMenus.onClicked', [info, tab ? this.tabObject(tab) : null]);
    });
    this.tabSession = deps.session;
    this.proxy = new ExtensionProxy(
      deps.session,
      http,
      (choice) => {
        service.setProxy(
          choice ? { extension: choice.extension, description: choice.description } : null,
        );
      },
      (id, details) => {
        this.fireIn(id, 'proxy.settings.onChange', [details]);
      },
    );
    this.userScripts = new ExtensionUserScripts(service, () => {
      this.applyAll();
    });
    this.natives = new NativeHosts(
      (_extension, portId, message) => {
        const origin = this.nativeOrigins.get(portId);
        if (origin) {
          this.evalIn(
            origin,
            `self.__wsExt && __wsExt.nativeMessage(${JSON.stringify(portId)}, ${JSON.stringify(message)});`,
          );
        }
      },
      (_extension, portId, error) => {
        const origin = this.nativeOrigins.get(portId);
        this.nativeOrigins.delete(portId);
        if (origin) {
          this.evalIn(
            origin,
            `self.__wsExt && __wsExt.nativeClosed(${JSON.stringify(portId)}, ${JSON.stringify(error)});`,
          );
        }
      },
    );
    this.scripts = new ExtensionScripts(service, () => {
      this.applyAll();
    });
    this.dnr = new ExtensionDnr(
      service,
      (extension, path) => this.readSource(extension, path),
      () => {
        this.applyAll();
      },
    );
    this.extras = new ExtensionExtras(
      service,
      host,
      deps.cookieManager,
      deps.allCookies,
      deps.history,
      deps.session,
      deps.app,
      {
        fire: (id, event, args) => {
          this.fireIn(id, event, args);
        },
        ask: (extension, permissions, origins) =>
          this.askPermission(extension, permissions, origins),
        searchUrl: deps.searchUrl,
        windowSize: () => {
          const root = this.anchor.get_root();
          return { width: root?.get_width() ?? 1280, height: root?.get_height() ?? 800 };
        },
      },
    );
    service.onChanged(() => {
      void this.refresh();
    });
    // An extension already installed and turned on from a previous run needs its background page
    // and its declarativeNetRequest filters the moment the browser starts, not only reactively:
    // `refresh()` otherwise only ever runs when something later changes the extensions' state
    // (install, enable/disable, a setting), which a quiet startup with nothing to react to never
    // does — every port a content script or a popup opened then found no background to talk to.
    void this.refresh();
    host.onTabsChanged(() => {
      this.tabsChanged();
    });
  }

  extensionFor(id: string): LoadedExtension | undefined {
    return this.service.get(id);
  }

  /**
   * May this tab navigate to `webswitch-ext://<id>/...`? Only when `tabs.create`/`tabs.update` just
   * asked for this exact address (consumed here, one-time) or the tab is already showing that same
   * extension's own page (an in-page link from one of its pages to another). A foreign page's link
   * click or redirect is never pre-approved, so it stays blocked — this only lifts the block for
   * navigations the extension itself asked for through its own, already-gated API.
   */
  allowsTabNavigation(view: WebKit.WebView, uri: string): boolean {
    const id = GLib.Uri.parse(uri, GLib.UriFlags.NONE).get_host() ?? '';
    if (this.service.get(id) === undefined) return false;
    if (this.pendingOwnNavigation.delete(uri)) {
      this.tabExtension.set(view, id);
      // The page's own script is about to run: it needs the full chrome.* shim (addOwnPageShim,
      // via applyTo) in place before the document loads, not only whatever isolated-world content
      // script the manifest's `matches` happen to cover (an onboarding page usually matches none).
      this.applyTo(view);
      return true;
    }
    return this.tabExtension.get(view) === id;
  }

  /** Same extension id as the one whose own page this regular tab is currently showing, if any. */
  tabOwnsExtension(view: WebKit.WebView, id: string): boolean {
    return this.tabExtension.get(view) === id;
  }

  /** Marks `url` (the extension's own page) as pre-approved for the next navigation that asks for it. */
  private allowOwnNavigation(id: string, url: string): void {
    if (url.startsWith(`${EXTENSION_SCHEME}://${id}/`)) this.pendingOwnNavigation.add(url);
  }

  /** Puts the extensions' scripts, styles and rules into a tab's view (and keeps them up to date). */
  attachTab(view: WebKit.WebView): void {
    this.attached.add(new WeakRef(view));
    this.applyTo(view);
    if (this.watched.has(view)) return;
    this.watched.add(view);
    view.connect('load-changed', (_view, event) => {
      this.navigated(view, event);
    });
    view.connect('context-menu', (_view, menu, hit) => {
      this.menus.populate(view, menu, ExtensionMenus.targetOf(hit));
      return false;
    });
    view.connect('resource-load-started', (_view, resource, request) => {
      if (this.requestCount > 0) this.watchRequest(view, resource, request);
    });
  }

  /** Puts the scripts, styles and rules again into every open tab. */
  private applyAll(): void {
    for (const ref of [...this.attached]) {
      const view = ref.deref();
      if (view) this.applyTo(view);
      else this.attached.delete(ref);
    }
  }

  isExtensionView(view: WebKit.WebView | null): boolean {
    return view !== null && this.pageViews.has(view);
  }

  /** May a page that is not the extension's own load this file? Only if the manifest says so. */
  isAccessible(extension: LoadedExtension, relative: string): boolean {
    for (const entry of extension.manifest.web_accessible_resources ?? []) {
      const resources = typeof entry === 'string' ? [entry] : (entry.resources ?? []);
      for (const resource of resources) {
        const parts = resource.replace(/^\//, '').split('*').map(escapeRegex);
        if (new RegExp(`^${parts.join('.*')}$`).test(relative)) return true;
      }
    }
    return false;
  }

  /** The page a background script or service worker is run in. */
  backgroundPage(id: string): string | null {
    const background = this.service.get(id)?.manifest.background;
    if (!background) return null;
    const tag = (path: string, module: boolean): string =>
      `<script ${module ? 'type="module" ' : ''}src="/${encodeURI(path.replace(/^\//, ''))}"></script>`;
    const tags = background.service_worker
      ? [tag(background.service_worker, background.type === 'module')]
      : (background.scripts ?? []).map((path) => tag(path, false));
    return tags.length === 0
      ? null
      : `<!doctype html><meta charset="utf-8"><title>background</title>${tags.join('')}`;
  }

  /** Puts everything in place again after an extension was installed, turned on or off, or removed. */
  async refresh(): Promise<void> {
    const active = this.service.active();
    const key = active
      .map((extension) => `${extension.summary.id}@${String(extension.meta.installedAt)}`)
      .join(',');
    if (key === this.applied) return;
    this.applied = key;
    await this.dnr.sync(active);
    this.applyAll();
    const installed = new Set(this.service.getState().extensions.map((item) => item.id));
    for (const id of this.known) {
      if (installed.has(id)) continue;
      this.menus.forget(id);
      this.scripts.forget(id);
      this.userScripts.forget(id);
      this.proxy.clear(id);
      this.dnr.forget(id);
      this.requestListeners.delete(id);
      this.blockingListeners.delete(id);
    }
    this.known = installed;
    this.countRequestListeners();
    const ids = new Set(active.map((extension) => extension.summary.id));
    for (const [id, background] of [...this.backgrounds]) {
      if (ids.has(id)) continue;
      this.natives.closeAll(id);
      this.proxy.clear(id);
      this.closeOffscreen(id);
      this.dropPortsOf(background.view);
      this.pageViews.delete(background.view);
      background.view.run_dispose();
      this.backgrounds.delete(id);
    }
    for (const extension of active) {
      if (!this.backgrounds.has(extension.summary.id)) this.startBackground(extension);
    }
  }

  /** Opens an extension's popup under `rect` (the toolbar button, in the anchor's coordinates). */
  async openPopup(
    id: string,
    rect: { x: number; y: number; width: number; height: number },
  ): Promise<void> {
    const extension = this.service.get(id);
    if (!extension || !this.service.active().includes(extension)) return;
    const { manifest } = extension;
    const action = manifest.action ?? manifest.browser_action ?? manifest.page_action;
    const popup = this.service.action(id).popup ?? action?.default_popup ?? null;
    if (popup === null) {
      // No popup: clicking the button is the extension's own action.
      const background = this.backgrounds.get(id);
      if (!background) return;
      await background.loaded;
      const tab = this.host.listTabs().find((candidate) => candidate.active);
      this.fireIn(id, 'action.onClicked', [tab ? this.tabObject(tab) : null]);
      return;
    }
    this.popover?.popdown();
    // The popup reports its size once it has laid out, and again when it changes.
    const sizing = new WebKit.UserScript(
      `addEventListener('DOMContentLoaded', () => { const report = () => self.__wsExt && __wsExt.reportSize(); setTimeout(report, 50); new ResizeObserver(report).observe(document.documentElement); });`,
      WebKit.UserContentInjectedFrames.TOP_FRAME,
      WebKit.UserScriptInjectionTime.START,
      null,
      null,
    );
    const view = this.pageView(extension, [sizing]);
    view.set_size_request(380, 300);
    const popover = new Gtk.Popover();
    popover.set_parent(this.anchor);
    popover.set_position(Gtk.PositionType.BOTTOM);
    popover.set_pointing_to(new Gdk.Rectangle(rect));
    popover.set_child(view);
    popover.connect('closed', () => {
      debug('extension-api', `popup for ${id} closed`);
      this.dropPortsOf(view);
      this.pageViews.delete(view);
      if (this.popover === popover) this.popover = null;
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        // The popover still holds `view` as its child; disposing it first left that reference
        // dangling ("has a parent GtkPopoverContent during dispose") and corrupted GTK's own
        // bookkeeping for the rest of the run. Let go of it as a child before tearing anything down.
        popover.set_child(null);
        popover.unparent();
        view.run_dispose();
        return GLib.SOURCE_REMOVE;
      });
    });
    this.popover = popover;
    view.load_uri(`${EXTENSION_SCHEME}://${id}/${popup.replace(/^\//, '')}`);
    popover.popup();
  }

  /** Runs a script in an extension's background page and returns what it answers (for the self-test). */
  async evaluateInBackground(id: string, script: string): Promise<string> {
    const background = this.backgrounds.get(id);
    if (!background) return 'no background page';
    const value = await background.view.evaluate_javascript(script, -1, null, null, null);
    return value.to_string();
  }

  /**
   * A page or frame is about to load. Rules of declarativeNetRequest (block, redirect) answer at once;
   * extensions with a blocking `webRequest.onBeforeRequest` listener are asked, waiting a few seconds
   * at most. Returns null when nobody has anything to say, so ordinary navigations are never delayed.
   * Only navigations can be handled this way: WebKitGTK gives no hook to stop a script or an image.
   */
  interceptNavigation(
    view: WebKit.WebView,
    url: string,
    type: 'main_frame' | 'sub_frame',
  ): RequestVerdict | Promise<RequestVerdict> | null {
    if (!/^https?:/i.test(url)) return null;
    const active = this.service.active();
    if (active.length === 0) return null;
    const previous = this.lastRedirect.get(view);
    const looping = previous?.url === url && Date.now() - previous.at < 3000;
    let redirect: string | null = null;
    if (!looping) {
      for (const extension of active) {
        const verdict = this.dnr.navigationVerdict(
          extension.summary.id,
          url,
          type,
          `${EXTENSION_SCHEME}://${extension.summary.id}/`,
        );
        if (verdict?.kind === 'block') return { cancel: true };
        if (verdict?.kind === 'redirect') redirect ??= verdict.url;
      }
    }
    if (redirect !== null) {
      this.lastRedirect.set(view, { url: redirect, at: Date.now() });
      return { redirectUrl: redirect };
    }
    const askers = active.filter(
      (extension) =>
        this.has(extension, 'webRequestBlocking') &&
        this.blockingListeners.get(extension.summary.id)?.has('onBeforeRequest') === true &&
        this.backgrounds.has(extension.summary.id) &&
        matchesAny(hostsOf(extension.manifest), url),
    );
    if (askers.length === 0) return null;
    const tabId = this.host.tabIdOf(view);
    const page = view.get_uri();
    const details = {
      requestId: String(++this.requestSequence),
      url,
      method: 'GET',
      frameId: type === 'main_frame' ? 0 : 1,
      parentFrameId: type === 'main_frame' ? -1 : 0,
      tabId: tabId ?? -1,
      type,
      timeStamp: Date.now(),
      initiator: type === 'main_frame' ? undefined : /^https?:\/\/[^/?#]+/.exec(page)?.[0],
    };
    return (async (): Promise<RequestVerdict> => {
      for (const extension of askers) {
        const background = this.backgrounds.get(extension.summary.id);
        if (!background) continue;
        const answer = await this.request(
          background.view,
          null,
          (callId) =>
            `self.__wsExt && __wsExt.beforeRequest(${String(callId)}, ${JSON.stringify(details)});`,
          NAVIGATION_ANSWER_S,
        );
        const verdict = answer.response as RequestVerdict | null;
        if (verdict?.cancel === true) return { cancel: true };
        if (typeof verdict?.redirectUrl === 'string') {
          this.lastRedirect.set(view, { url: verdict.redirectUrl, at: Date.now() });
          return { redirectUrl: verdict.redirectUrl };
        }
      }
      return {};
    })();
  }

  /**
   * A site asks for a username and password. Extensions that keep logins and listen for it
   * (`webRequest.onAuthRequired` with the webRequestAuthProvider permission) are asked first;
   * `fallback` runs when none of them has credentials. Returns whether one was asked.
   */
  authenticate(
    view: WebKit.WebView,
    request: WebKit.AuthenticationRequest,
    fallback: () => void,
  ): boolean {
    const providers = this.service
      .active()
      .filter(
        (extension) =>
          this.has(extension, 'webRequestAuthProvider') &&
          this.requestListeners.get(extension.summary.id)?.has('onAuthRequired') === true &&
          this.backgrounds.has(extension.summary.id),
      );
    if (providers.length === 0) return false;
    const tabId = this.host.tabIdOf(view);
    const host = request.get_host();
    const port = request.get_port();
    const schemeNames: Record<number, string> = {
      [WebKit.AuthenticationScheme.HTTP_BASIC]: 'basic',
      [WebKit.AuthenticationScheme.HTTP_DIGEST]: 'digest',
      [WebKit.AuthenticationScheme.NTLM]: 'ntlm',
      [WebKit.AuthenticationScheme.NEGOTIATE]: 'negotiate',
    };
    const scheme = schemeNames[request.get_scheme()];
    const details = {
      requestId: String(++this.requestSequence),
      url: view.get_uri(),
      method: 'GET',
      frameId: 0,
      parentFrameId: -1,
      tabId: tabId ?? -1,
      type: 'main_frame',
      timeStamp: Date.now(),
      scheme: scheme ?? 'basic',
      realm: request.get_realm() || undefined,
      challenger: { host, port },
      isProxy: request.is_for_proxy(),
      statusCode: 401,
      statusLine: 'HTTP/1.1 401 Unauthorized',
      responseHeaders: [],
    };
    void (async () => {
      for (const extension of providers) {
        const background = this.backgrounds.get(extension.summary.id);
        if (!background) continue;
        const answer = await this.request(
          background.view,
          null,
          (callId) =>
            `self.__wsExt && __wsExt.authRequired(${String(callId)}, ${JSON.stringify(details)});`,
        );
        const credentials = (
          answer.response as { authCredentials?: { username?: string; password?: string } } | null
        )?.authCredentials;
        if (typeof credentials?.username === 'string' && typeof credentials.password === 'string') {
          request.authenticate(
            new WebKit.Credential(
              credentials.username,
              credentials.password,
              WebKit.CredentialPersistence.FOR_SESSION,
            ),
          );
          return;
        }
      }
      fallback();
    })();
    return true;
  }

  /** Adds the extensions' context menu items for a click on `target` (the self-test calls this too). */
  populateMenu(view: WebKit.WebView, menu: WebKit.ContextMenu, target: MenuTarget): void {
    this.menus.populate(view, menu, target);
  }

  private closeOffscreen(id: string): void {
    const view = this.offscreens.get(id);
    if (!view) return;
    this.offscreens.delete(id);
    this.dropPortsOf(view);
    this.pageViews.delete(view);
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      view.run_dispose();
      return GLib.SOURCE_REMOVE;
    });
  }

  /**
   * `chrome.identity.launchWebAuthFlow`: a window with the sign-in page, in the same session as the
   * tabs (so a Google or GitHub sign-in already there is used). It ends when the page goes to the
   * extension's `https://<id>.chromiumapp.org/` address, which is the answer; closing the window is a no.
   */
  private authFlow(
    extension: LoadedExtension,
    details: { url?: string; interactive?: boolean },
  ): Promise<string> {
    this.require(extension, 'identity');
    const { id } = extension.summary;
    if (typeof details.url !== 'string' || !/^https?:\/\//i.test(details.url)) {
      return Promise.reject(new Error('Invalid URL.'));
    }
    // Without a person to click nothing can be approved.
    if (details.interactive !== true) {
      return Promise.reject(new Error('User interaction required.'));
    }
    const start = details.url;
    const base = `https://${id}.chromiumapp.org/`;
    return new Promise((resolve, reject) => {
      const view = new WebKit.WebView({ network_session: this.tabSession });
      const host = /^https?:\/\/([^/?#]+)/i.exec(start)?.[1] ?? '';
      const window = new Gtk.Window({
        title: `Sign in for ${extension.summary.name} (${host})`,
        default_width: 520,
        default_height: 720,
      });
      const root = this.anchor.get_root();
      if (root instanceof Gtk.Window) window.set_transient_for(root);
      let finished = false;
      const end = (result: string | Error): void => {
        if (finished) return;
        finished = true;
        if (typeof result === 'string') resolve(result);
        else reject(result);
        window.close();
      };
      view.connect('decide-policy', (_view, decision, type) => {
        if (
          type !== WebKit.PolicyDecisionType.NAVIGATION_ACTION &&
          type !== WebKit.PolicyDecisionType.NEW_WINDOW_ACTION
        ) {
          return false;
        }
        const uri = (decision as WebKit.NavigationPolicyDecision)
          .get_navigation_action()
          .get_request()
          .get_uri();
        if (uri.startsWith(base) || uri === base.slice(0, -1)) {
          decision.ignore();
          end(uri);
          return true;
        }
        return false;
      });
      window.connect('close-request', () => {
        end(new Error('The user did not approve access.'));
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          view.run_dispose();
          return GLib.SOURCE_REMOVE;
        });
        return false;
      });
      window.set_child(view);
      view.load_uri(start);
      window.present();
    });
  }

  /** The user pressed Stop on the notice about a proxy an extension set: the system's settings come back. */
  clearProxy(): void {
    this.proxy.clear();
  }

  /** The view of the popup that is open, if any (the self-test looks at it). */
  popupView(): WebKit.WebView | null {
    const child = this.popover?.get_child();
    return child instanceof WebKit.WebView ? child : null;
  }

  /** The options page in a window of its own. */
  openOptions(id: string): void {
    const extension = this.service.get(id);
    const page = extension?.manifest.options_ui?.page ?? extension?.manifest.options_page;
    if (!extension || !page || !this.service.active().includes(extension)) return;
    const view = this.pageView(extension, []);
    view.load_uri(`${EXTENSION_SCHEME}://${id}/${page.replace(/^\//, '')}`);
    const window = new Gtk.Window({
      title: extension.summary.name,
      default_width: 900,
      default_height: 700,
    });
    const root = this.anchor.get_root();
    if (root instanceof Gtk.Window) window.set_transient_for(root);
    window.set_child(view);
    window.connect('close-request', () => {
      this.dropPortsOf(view);
      this.pageViews.delete(view);
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        view.run_dispose();
        return GLib.SOURCE_REMOVE;
      });
      return false;
    });
    window.present();
  }

  /** The extension's own pages keep their storage apart from the tabs'. */
  private session(): WebKit.NetworkSession {
    this.network ??= WebKit.NetworkSession.new(
      GLib.build_filenamev([dataDir(), 'extensions-web']),
      GLib.build_filenamev([cacheDir(), 'extensions-web']),
    );
    return this.network;
  }

  private applyTo(view: WebKit.WebView): void {
    const manager = view.get_user_content_manager();
    manager.remove_all_scripts();
    manager.remove_all_style_sheets();
    manager.remove_all_filters();
    const active = this.service.active();
    for (const extension of active) {
      this.addContent(manager, view, extension);
      for (const filter of this.dnr.filtersOf(extension.summary.id)) manager.add_filter(filter);
    }
    // A tab currently on one of an extension's own pages (see `allowsTabNavigation`) is as privileged
    // as that extension's background/popup/options views, not limited to whatever its content_scripts
    // happen to match (an onboarding page, for instance, matches no content script at all).
    const ownedId = this.tabExtension.get(view);
    const owned = ownedId !== undefined ? this.service.get(ownedId) : undefined;
    if (owned) this.addOwnPageShim(manager, view, owned);
  }

  /** Gives a regular tab the same full chrome.* shim, in the main world, that `pageView()` gives a
   * background/popup/options view — for as long as `tabExtension` says it owns that extension. */
  private addOwnPageShim(
    manager: WebKit.UserContentManager,
    view: WebKit.WebView,
    extension: LoadedExtension,
  ): void {
    const { id } = extension.summary;
    const name = handlerOf(id);
    const key = `${name}:main`;
    manager.add_script(
      new WebKit.UserScript(
        buildShim(this.shimConfig(extension, 'page')),
        WebKit.UserContentInjectedFrames.TOP_FRAME,
        WebKit.UserScriptInjectionTime.START,
        null,
        null,
      ),
    );
    const done = this.registered.get(manager) ?? new Set<string>();
    this.registered.set(manager, done);
    if (done.has(key)) return;
    done.add(key);
    manager.register_script_message_handler_with_reply(name, null);
    manager.connect(`script-message-with-reply-received::${name}`, (_manager, value, reply) => {
      void this.dispatch(id, { kind: 'page', view }, value, reply);
      return true;
    });
  }

  /** What the chrome.* shim is told about its extension and the user. */
  private shimConfig(extension: LoadedExtension, kind: 'content' | 'page'): ShimConfig {
    const { id } = extension.summary;
    return {
      id,
      kind,
      base: `${EXTENSION_SCHEME}://${id}/`,
      manifest: extension.manifest,
      messages: extension.messages,
      language: this.languages[0],
      languages: this.languages,
    };
  }

  private readSource(extension: LoadedExtension, relative: string): string | null {
    if (relative.includes('..')) return null;
    try {
      const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([extension.files, relative]));
      return bytes.length > MAX_SCRIPT_BYTES ? null : new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  /** The content scripts and styles of one extension, into one tab's user content manager. */
  private addContent(
    manager: WebKit.UserContentManager,
    view: WebKit.WebView,
    extension: LoadedExtension,
  ): void {
    const { id } = extension.summary;
    const world = worldOf(id);
    const name = handlerOf(id);
    const done = this.registered.get(manager) ?? new Set<string>();
    this.registered.set(manager, done);
    if (!done.has(name)) {
      done.add(name);
      manager.register_script_message_handler_with_reply(name, world);
      manager.connect(`script-message-with-reply-received::${name}`, (_manager, value, reply) => {
        void this.dispatch(id, { kind: 'content', view }, value, reply);
        return true;
      });
    }
    const shim = buildShim(this.shimConfig(extension, 'content'));
    this.addUserScripts(manager, view, extension);
    for (const entry of [
      ...(extension.manifest.content_scripts ?? []),
      ...this.scripts.entries(id),
    ]) {
      const allow = toWebKitPatterns(entry.matches ?? []);
      // An empty list would mean "every page" to WebKit: nothing valid to match means no script.
      if (allow !== null && allow.length === 0) continue;
      const excluded = entry.exclude_matches ? toWebKitPatterns(entry.exclude_matches) : null;
      const block = excluded !== null && excluded.length > 0 ? excluded : null;
      const frames =
        entry.all_frames === true
          ? WebKit.UserContentInjectedFrames.ALL_FRAMES
          : WebKit.UserContentInjectedFrames.TOP_FRAME;
      const time =
        entry.run_at === 'document_start'
          ? WebKit.UserScriptInjectionTime.START
          : WebKit.UserScriptInjectionTime.END;
      const main = entry.world === 'MAIN';
      const files = (entry.js ?? [])
        .map((path) => this.readSource(extension, path))
        .filter((source): source is string => source !== null);
      // Each file is a script of its own (an error in one does not stop the next), all in one world.
      for (const source of main ? files : [shim, ...files]) {
        manager.add_script(
          main
            ? new WebKit.UserScript(source, frames, time, allow, block)
            : WebKit.UserScript.new_for_world(source, frames, time, world, allow, block),
        );
      }
      for (const path of entry.css ?? []) {
        const css = this.readSource(extension, path);
        if (css === null) continue;
        // WebKit applies no AUTHOR level user style sheet here (measured), and a USER level one loses
        // to the page's own rules of the same weight. So both: the sheet, which always applies (and
        // ignores the page's CSP), and a <style> element added by a script, which ranks like Chrome's.
        manager.add_style_sheet(
          new WebKit.UserStyleSheet(css, frames, WebKit.UserStyleLevel.USER, allow, block),
        );
        manager.add_script(
          WebKit.UserScript.new_for_world(
            styleScript(css),
            frames,
            WebKit.UserScriptInjectionTime.START,
            world,
            allow,
            block,
          ),
        );
      }
    }
  }

  /** The scripts of `chrome.userScripts`, in their own world (or the page's own when they ask for it). */
  private addUserScripts(
    manager: WebKit.UserContentManager,
    view: WebKit.WebView,
    extension: LoadedExtension,
  ): void {
    const { id } = extension.summary;
    if (!(extension.manifest.permissions ?? []).includes('userScripts')) return;
    const entries = this.userScripts.entries(id);
    if (entries.length === 0) return;
    const world = userWorldOf(id);
    const name = `${handlerOf(id)}_us`;
    const done = this.registered.get(manager) ?? new Set<string>();
    this.registered.set(manager, done);
    if (!done.has(name)) {
      done.add(name);
      manager.register_script_message_handler_with_reply(name, world);
      manager.connect(`script-message-with-reply-received::${name}`, (_manager, value, reply) => {
        void this.dispatch(id, { kind: 'userscript', view }, value, reply);
        return true;
      });
    }
    const shim = buildUserShim(id, this.userScripts.world(id).messaging);
    for (const entry of entries) {
      const allow = toWebKitPatterns(entry.matches ?? []);
      if (allow !== null && allow.length === 0) continue;
      const excluded = entry.excludeMatches ? toWebKitPatterns(entry.excludeMatches) : null;
      const block = excluded !== null && excluded.length > 0 ? excluded : null;
      const frames =
        entry.allFrames === true
          ? WebKit.UserContentInjectedFrames.ALL_FRAMES
          : WebKit.UserContentInjectedFrames.TOP_FRAME;
      const time =
        entry.runAt === 'document_start'
          ? WebKit.UserScriptInjectionTime.START
          : WebKit.UserScriptInjectionTime.END;
      const guard = globGuard(entry.includeGlobs, entry.excludeGlobs);
      for (const item of entry.js ?? []) {
        const code =
          typeof item.code === 'string'
            ? item.code
            : typeof item.file === 'string'
              ? this.readSource(extension, item.file)
              : null;
        if (code === null) continue;
        const source = guard === null ? code : `if (${guard}) {\n${code}\n}`;
        manager.add_script(
          entry.world === 'MAIN'
            ? new WebKit.UserScript(source, frames, time, allow, block)
            : WebKit.UserScript.new_for_world(
                `${shim}\n${source}`,
                frames,
                time,
                world,
                allow,
                block,
              ),
        );
      }
    }
  }

  /** A view for one of the extension's own pages: it gets the full chrome.* shim and its handler. */
  private pageView(extension: LoadedExtension, extra: WebKit.UserScript[]): WebKit.WebView {
    const { id } = extension.summary;
    const config = this.shimConfig(extension, 'page');
    const manager = new WebKit.UserContentManager();
    manager.add_script(
      new WebKit.UserScript(
        buildShim(config),
        WebKit.UserContentInjectedFrames.TOP_FRAME,
        WebKit.UserScriptInjectionTime.START,
        null,
        null,
      ),
    );
    for (const script of extra) manager.add_script(script);
    manager.register_script_message_handler_with_reply(handlerOf(id), null);
    const view = new WebKit.WebView({
      user_content_manager: manager,
      network_session: this.session(),
      // An extension's own errors show in the terminal while debugging.
      settings: new WebKit.Settings({
        enable_write_console_messages_to_stdout: DEBUG,
        // An extension's own page may copy without a click (its background has nobody to click).
        javascript_can_access_clipboard: true,
      }),
    });
    this.pageViews.set(view, id);
    view.connect('web-process-terminated', (_view, reason) => {
      debug('extension-api', `an extension page's web process ended (reason ${String(reason)})`);
    });
    view.connect('load-failed', (_view, _event, uri, error) => {
      debug('extension-api', `an extension page failed to load ${uri}: ${error.message}`);
      return false;
    });
    manager.connect(
      `script-message-with-reply-received::${handlerOf(id)}`,
      (_manager, value, reply) => {
        void this.dispatch(id, { kind: 'page', view }, value, reply);
        return true;
      },
    );
    return view;
  }

  private startBackground(extension: LoadedExtension): void {
    const { id, hasBackground } = extension.summary;
    if (!hasBackground) return;
    const view = this.pageView(extension, []);
    const loaded = new Promise<void>((resolve) => {
      view.connect('load-changed', (_view, event) => {
        if (event === WebKit.LoadEvent.FINISHED) resolve();
      });
    });
    this.backgrounds.set(id, { view, loaded });
    // The extension's own listeners exist once its scripts have run.
    const reason = this.service.takeFresh(id);
    void loaded.then(() => {
      if (reason === null) this.fireIn(id, 'runtime.onStartup', []);
      else this.fireIn(id, 'runtime.onInstalled', [{ reason }]);
    });
    const page = extension.manifest.background?.page;
    view.load_uri(`${EXTENSION_SCHEME}://${id}/${page ?? '_generated_background.html'}`);
  }

  private async dispatch(
    id: string,
    source: RuntimeSource,
    value: JavaScriptCore.Value,
    reply: WebKit.ScriptMessageReply,
  ): Promise<void> {
    try {
      const extension = this.service.get(id);
      if (!extension || !this.service.active().includes(extension)) {
        throw new Error('The extension is not on.');
      }
      const call = JSON.parse(value.to_string()) as ExtensionCall;
      if (DEBUG && call.op !== 'runtime.respond') {
        debug('extension-api', `${source.kind} ${call.op} ${JSON.stringify(call).slice(0, 160)}`);
      }
      const result = await this.handle(extension, source, call);
      reply.return_value(
        JavaScriptCore.Value.new_string(
          value.get_context(),
          result === undefined ? '' : JSON.stringify(result),
        ),
      );
    } catch (error) {
      debug('extension-api', `failed: ${error instanceof Error ? error.message : String(error)}`);
      reply.return_error_message(error instanceof Error ? error.message : String(error));
    }
  }

  private has(extension: LoadedExtension, permission: string): boolean {
    return (extension.manifest.permissions ?? []).includes(permission);
  }

  private senderOf(extension: LoadedExtension, source: RuntimeSource): Record<string, unknown> {
    const tabId = source.kind !== 'page' ? this.host.tabIdOf(source.view) : null;
    const found =
      tabId === null ? undefined : this.host.listTabs().find((item) => item.id === tabId);
    const url = source.view.get_uri();
    return {
      id: extension.summary.id,
      url,
      // Extension pages have the extension's own origin; extensions check it to tell who is talking.
      origin: url.startsWith(`${EXTENSION_SCHEME}:`)
        ? `${EXTENSION_SCHEME}://${extension.summary.id}`
        : /^https?:/.test(url)
          ? /^https?:\/\/[^/?#]+/.exec(url)?.[0]
          : undefined,
      frameId: 0,
      ...(found ? { tab: this.tabObject(found) } : {}),
    };
  }

  private async handle(
    extension: LoadedExtension,
    source: RuntimeSource,
    call: ExtensionCall,
  ): Promise<unknown> {
    const { id } = extension.summary;
    switch (call.op) {
      case 'storage.get':
      case 'storage.set':
      case 'storage.remove':
      case 'storage.clear':
        if (!this.has(extension, 'storage')) {
          throw new Error("The extension did not ask for the 'storage' permission.");
        }
        return this.handleStorage(id, call);
      case 'runtime.sendMessage':
        return await this.route(extension, source, call.message);
      case 'runtime.respond': {
        const callId = Number(call.callId);
        this.waiting.get(callId)?.({ response: call.response, empty: call.empty === true });
        this.waiting.delete(callId);
        return undefined;
      }
      case 'port.connect':
        await this.portConnect(extension, source, call);
        return undefined;
      case 'port.post':
        await this.portPost(extension, source, call);
        return undefined;
      case 'port.disconnect':
        this.portDisconnect(extension, source, String(call.portId));
        return undefined;
      case 'offscreen.create': {
        this.require(extension, 'offscreen');
        const parameters = (call.parameters ?? {}) as {
          url?: string;
          reasons?: string[];
          justification?: string;
        };
        if (this.offscreens.has(id))
          throw new Error('Only a single offscreen document may be created.');
        if (
          typeof parameters.url !== 'string' ||
          /^[a-z][a-z0-9+.-]*:/i.test(parameters.url) ||
          parameters.url.includes('..')
        ) {
          throw new Error('The offscreen document must be a file of the extension.');
        }
        if (!Array.isArray(parameters.reasons) || parameters.reasons.length === 0) {
          throw new Error('At least one reason is required.');
        }
        if (typeof parameters.justification !== 'string' || parameters.justification === '') {
          throw new Error('A justification is required.');
        }
        const view = this.pageView(extension, []);
        this.offscreens.set(id, view);
        view.load_uri(`${EXTENSION_SCHEME}://${id}/${parameters.url.replace(/^\//, '')}`);
        return undefined;
      }
      case 'offscreen.close':
        this.require(extension, 'offscreen');
        if (!this.offscreens.has(id)) throw new Error('No current offscreen document.');
        this.closeOffscreen(id);
        return undefined;
      case 'offscreen.has':
        return this.offscreens.has(id);
      case 'runtime.getContexts': {
        const kinds = ((call.filter ?? {}) as { contextTypes?: string[] }).contextTypes;
        const contexts: Record<string, unknown>[] = [];
        const add = (contextType: string, view: WebKit.WebView): void => {
          contexts.push({
            contextType,
            contextId: `${contextType}-${id}`,
            tabId: -1,
            windowId: -1,
            documentUrl: view.get_uri(),
            documentOrigin: `${EXTENSION_SCHEME}://${id}`,
            frameId: 0,
            incognito: false,
          });
        };
        const background = this.backgrounds.get(id);
        if (background) add('BACKGROUND', background.view);
        const offscreen = this.offscreens.get(id);
        if (offscreen) add('OFFSCREEN_DOCUMENT', offscreen);
        const popup = this.popupView();
        if (popup && this.pageViews.get(popup) === id) add('POPUP', popup);
        return contexts.filter(
          (context) => kinds === undefined || kinds.includes(String(context.contextType)),
        );
      }
      case 'identity.auth':
        return await this.authFlow(extension, call.details ?? {});
      case 'events.listen': {
        const name = String(call.name);
        if (name === 'cookies.onChanged') this.require(extension, 'cookies');
        else if (name === 'history.onVisited') this.require(extension, 'history');
        else return undefined;
        const set = this.eventListeners.get(name) ?? new Set<string>();
        set.add(id);
        this.eventListeners.set(name, set);
        this.extras.subscribe(id, name);
        return undefined;
      }
      case 'proxy.get':
        this.require(extension, 'proxy');
        return this.proxy.get(id);
      case 'proxy.set': {
        this.require(extension, 'proxy');
        const value = (call.details as { value?: Record<string, unknown> } | undefined)?.value;
        if (!value) throw new Error('A proxy setting needs a value.');
        this.proxy.set(extension, value);
        return undefined;
      }
      case 'proxy.clear':
        this.require(extension, 'proxy');
        this.proxy.clear(id);
        return undefined;
      case 'userscript.message': {
        if (!this.userScripts.world(id).messaging) {
          throw new Error('Messaging is not on for user scripts.');
        }
        const background = this.backgrounds.get(id);
        if (!background) return undefined;
        await background.loaded;
        const sender = JSON.stringify(this.senderOf(extension, source));
        const answer = await this.request(
          background.view,
          null,
          (callId) =>
            `self.__wsExt && __wsExt.userScriptMessage(${String(callId)}, ${JSON.stringify(call.message ?? null)}, ${sender});`,
        );
        return answer.empty ? undefined : answer.response;
      }
      case 'native.connect': {
        this.require(extension, 'nativeMessaging');
        if (source.kind === 'content')
          throw new Error('Native messaging is not available in content scripts.');
        const portId = String(call.portId);
        this.nativeOrigins.set(portId, this.endpointOf(source, id));
        try {
          this.natives.connect(id, portId, String(call.name));
        } catch (error) {
          this.nativeOrigins.delete(portId);
          throw error;
        }
        return undefined;
      }
      case 'native.post':
        this.require(extension, 'nativeMessaging');
        await this.natives.post(id, String(call.portId), call.message);
        return undefined;
      case 'native.disconnect':
        this.nativeOrigins.delete(String(call.portId));
        this.natives.disconnect(id, String(call.portId));
        return undefined;
      case 'native.send':
        this.require(extension, 'nativeMessaging');
        if (source.kind === 'content')
          throw new Error('Native messaging is not available in content scripts.');
        return await this.natives.sendOnce(id, String(call.name), call.message);
      case 'webNavigation.getAllFrames':
        return this.host.viewOf(Number((call.details as { tabId?: number }).tabId))
          ? [{ frameId: 0, parentFrameId: -1, url: '', errorOccurred: false }]
          : null;
      case 'runtime.openOptionsPage':
        this.openOptions(id);
        return undefined;
      case 'popup.size':
        this.sizePopup(Number(call.w), Number(call.h));
        return undefined;
      case 'tabs.query':
        return this.queryTabs(extension, (call.query ?? {}) as Record<string, unknown>);
      case 'tabs.get': {
        const found = this.queryTabs(extension, {}).find((tab) => tab.id === Number(call.id));
        if (!found) throw new Error(`No tab with id: ${String(call.id)}.`);
        return found;
      }
      case 'tabs.create': {
        const props = call.props as { url?: string; active?: boolean };
        const url = props.url ?? 'about:blank';
        this.allowOwnNavigation(id, url);
        const tabId = this.host.createTab(url, props.active !== false);
        return this.queryTabs(extension, {}).find((tab) => tab.id === tabId) ?? { id: tabId, url };
      }
      case 'tabs.duplicate': {
        const url = this.host.viewOf(Number(call.id))?.get_uri() ?? 'about:blank';
        const tabId = this.host.createTab(url, true);
        return this.queryTabs(extension, {}).find((tab) => tab.id === tabId);
      }
      case 'tabs.update': {
        const tabId = this.tabIdFrom(call.id);
        const props = call.props as { url?: string; active?: boolean };
        if (tabId === undefined) return undefined;
        if (typeof props.url === 'string') {
          this.allowOwnNavigation(id, props.url);
          this.host.updateTab(tabId, props.url);
        }
        if (props.active === true) this.host.activateTab(tabId);
        return this.queryTabs(extension, {}).find((tab) => tab.id === tabId);
      }
      case 'tabs.remove':
        for (const tabId of call.ids as number[]) this.host.closeTab(tabId);
        return undefined;
      case 'tabs.reload': {
        const tabId = this.tabIdFrom(call.id);
        if (tabId !== undefined) this.host.reloadTab(tabId);
        return undefined;
      }
      case 'tabs.go': {
        const tabId = this.tabIdFrom(call.id);
        const view = tabId === undefined ? null : this.host.viewOf(tabId);
        if (call.direction === -1) view?.go_back();
        else view?.go_forward();
        return undefined;
      }
      case 'tabs.sendMessage':
        return await this.sendToTab(extension, Number(call.id), call.message, source);
      case 'tabs.captureVisibleTab':
        return await this.capture(extension);
      case 'tabs.executeScript': {
        const details = (call.details ?? {}) as Record<string, unknown>;
        const tabId = this.tabIdFrom(call.id);
        const injection = {
          target: { tabId },
          ...(typeof details.code === 'string' ? { code: details.code } : {}),
          ...(typeof details.file === 'string' ? { files: [details.file] } : {}),
        };
        const results = (await this.executeScript(extension, injection, false)) as {
          result: unknown;
        }[];
        return results.map((entry) => entry.result);
      }
      case 'tabs.insertCSS': {
        const details = (call.details ?? {}) as Record<string, unknown>;
        return await this.insertCss(
          extension,
          {
            target: { tabId: this.tabIdFrom(call.id) },
            ...(typeof details.code === 'string' ? { css: details.code } : {}),
            ...(typeof details.file === 'string' ? { files: [details.file] } : {}),
          },
          false,
        );
      }
      case 'scripting.executeScript':
        return await this.executeScript(extension, call.injection as Record<string, unknown>, true);
      case 'scripting.insertCSS':
        return await this.insertCss(extension, call.injection as Record<string, unknown>, true);
      case 'scripting.removeCSS':
        return undefined;
      case 'scripting.register':
        this.require(extension, 'scripting');
        this.scripts.register(id, call.scripts as RegisteredScript[]);
        return undefined;
      case 'scripting.update':
        this.require(extension, 'scripting');
        this.scripts.update(id, call.scripts as RegisteredScript[]);
        return undefined;
      case 'scripting.unregister':
        this.require(extension, 'scripting');
        this.scripts.unregister(id, call.filter as { ids?: string[] });
        return undefined;
      case 'scripting.getRegistered':
        this.require(extension, 'scripting');
        return this.scripts.getRegistered(id, call.filter as { ids?: string[] });
      case 'webRequest.listen': {
        this.require(extension, 'webRequest');
        const names = this.requestListeners.get(id) ?? new Set<string>();
        names.add(String(call.name));
        this.requestListeners.set(id, names);
        if (call.blocking === true) {
          this.require(extension, 'webRequestBlocking');
          const blocking = this.blockingListeners.get(id) ?? new Set<string>();
          blocking.add(String(call.name));
          this.blockingListeners.set(id, blocking);
        }
        this.countRequestListeners();
        return undefined;
      }
      case 'fetch':
        return await this.fetchFor(extension, call);
      default: {
        if (call.op.startsWith('dnr.')) return await this.dnr.handle(extension, call);
        if (call.op.startsWith('userScripts.')) return this.userScripts.handle(extension, call);
        if (call.op.startsWith('contextMenus.')) {
          this.require(extension, 'contextMenus');
          return this.menus.handle(id, call);
        }
        const extra = await this.extras.handle(extension, call);
        if (extra.handled) return extra.value;
        throw new Error(`chrome API '${call.op}' is not available in Webswitch.`);
      }
    }
  }

  private require(extension: LoadedExtension, permission: string): void {
    if (!this.has(extension, permission)) {
      throw new Error(`The extension did not ask for the '${permission}' permission.`);
    }
  }

  /** Tells an extension's background page that something happened (an event of `chrome.*`). */
  private fireIn(id: string, event: string, args: unknown[]): void {
    this.backgrounds
      .get(id)
      ?.view.evaluate_javascript(
        `self.__wsExt && __wsExt.fire(${JSON.stringify(event)}, ${JSON.stringify(args)});`,
        -1,
        null,
        null,
        null,
      )
      .catch(() => undefined);
  }

  /** A tab the way `chrome.tabs` describes it. */
  private tabObject(tab: TabBrief): Record<string, unknown> {
    const view = this.host.viewOf(tab.id);
    return {
      ...tab,
      status: view?.is_loading ? 'loading' : 'complete',
      favIconUrl: '',
      pinned: false,
      incognito: false,
      highlighted: tab.active,
      audible: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      width: 0,
      height: 0,
      mutedInfo: { muted: false },
    };
  }

  private async askPermission(
    extension: LoadedExtension,
    permissions: string[],
    origins: string[],
  ): Promise<boolean> {
    const root = this.anchor.get_root();
    if (!(root instanceof Gtk.Window)) return false;
    const dialog = new Gtk.AlertDialog({
      message: `Allow ${extension.summary.name} more access?`,
      detail: `It asks for:\n${[...permissions, ...origins].join('\n')}\n\nOnly allow this if you trust it.`,
      buttons: ['Deny', 'Allow'],
      cancel_button: 0,
      default_button: 0,
    });
    try {
      return (await dialog.choose(root, null)) === 1;
    } catch {
      return false;
    }
  }

  /** A shortcut an extension asked for (its `commands`). Returns whether one of them took the key. */
  handleShortcut(accelerator: string, repeated: boolean): boolean {
    for (const extension of this.service.active()) {
      for (const [name, command] of Object.entries(extension.manifest.commands ?? {})) {
        if (commandShortcut(command) !== accelerator) continue;
        if (repeated) return true;
        const { id } = extension.summary;
        if (/^_execute_(action|browser_action|page_action)$/.test(name)) {
          void this.openPopup(id, {
            x: Math.max(0, this.anchor.get_width() - 120),
            y: 70,
            width: 30,
            height: 30,
          });
        } else {
          const tab = this.host.listTabs().find((item) => item.active);
          this.fireIn(id, 'commands.onCommand', [name, tab ? this.tabObject(tab) : undefined]);
        }
        return true;
      }
    }
    return false;
  }

  private countRequestListeners(): void {
    let count = 0;
    for (const names of this.requestListeners.values()) count += names.size;
    this.requestCount = count;
  }

  /** Tells the extensions that watch requests what this one did (`chrome.webRequest`, observing only). */
  private watchRequest(
    view: WebKit.WebView,
    resource: WebKit.WebResource,
    request: WebKit.URIRequest,
  ): void {
    const tabId = this.host.tabIdOf(view);
    if (tabId === null) return;
    const url = resource.get_uri();
    const page = view.get_uri();
    const base = {
      requestId: String(++this.requestSequence),
      url,
      method: request.get_http_method() ?? 'GET',
      frameId: 0,
      parentFrameId: -1,
      tabId,
      type: url === page ? 'main_frame' : requestType(url),
      timeStamp: Date.now(),
      initiator: /^https?:\/\/[^/?#]+/.exec(page)?.[0],
    };
    const send = (event: string, extra: Record<string, unknown> = {}): void => {
      for (const extension of this.service.active()) {
        const { id } = extension.summary;
        if (!this.requestListeners.get(id)?.has(event)) continue;
        if (!this.has(extension, 'webRequest') || !matchesAny(hostsOf(extension.manifest), url))
          continue;
        this.fireIn(id, `webRequest.${event}`, [{ ...base, ...extra }]);
      }
    };
    const requestHeaders: { name: string; value: string }[] = [];
    request.get_http_headers()?.foreach((name, value) => {
      requestHeaders.push({ name, value });
    });
    send('onBeforeRequest');
    send('onBeforeSendHeaders', { requestHeaders });
    send('onSendHeaders', { requestHeaders });
    let status: Record<string, unknown> = {};
    let started = false;
    resource.connect('notify::response', () => {
      const response = resource.get_response();
      if (started || !response) return;
      started = true;
      const responseHeaders: { name: string; value: string }[] = [];
      response.get_http_headers()?.foreach((name, value) => {
        responseHeaders.push({ name, value });
      });
      status = {
        statusCode: response.get_status_code(),
        statusLine: `HTTP/1.1 ${String(response.get_status_code())}`,
        responseHeaders,
        fromCache: false,
      };
      send('onHeadersReceived', status);
      send('onResponseStarted', status);
    });
    resource.connect('finished', () => {
      send('onCompleted', status);
    });
    resource.connect('failed', (_resource, error) => {
      send('onErrorOccurred', { error: error.message });
    });
  }

  /** A tab id from a call, or the active tab when the extension left it out. */
  private tabIdFrom(id: unknown): number | undefined {
    return id === null || id === undefined
      ? this.host.listTabs().find((tab) => tab.active)?.id
      : Number(id);
  }

  // ── ports (chrome.runtime.connect) ─────────────────────────────────────────────────────────
  private endpointOf(source: RuntimeSource, extension: string): PortEndpoint {
    return {
      view: new WeakRef(source.view),
      world:
        source.kind === 'content'
          ? worldOf(extension)
          : source.kind === 'userscript'
            ? userWorldOf(extension)
            : null,
    };
  }

  private evalIn(endpoint: PortEndpoint, script: string): void {
    endpoint.view
      .deref()
      ?.evaluate_javascript(script, -1, endpoint.world, null, null)
      .catch((error: unknown) => {
        debug('extension-api', `could not run ${script.slice(0, 60)}: ${String(error)}`);
      });
  }

  /** Where a port's messages go: to the peers when they come from its origin, else back to the origin. */
  private otherSides(entry: PortEntry, source: RuntimeSource): PortEndpoint[] {
    return entry.origin.view.deref() === source.view ? entry.peers : [entry.origin];
  }

  private portConnect(
    extension: LoadedExtension,
    source: RuntimeSource,
    call: ExtensionCall,
  ): Promise<void> {
    const { id } = extension.summary;
    const portId = String(call.portId);
    for (const [key, entry] of this.ports) if (!entry.origin.view.deref()) this.ports.delete(key);
    const entry: PortEntry = {
      extension: id,
      origin: this.endpointOf(source, id),
      peers: [],
      ready: Promise.resolve(),
    };
    // Registered before anything is awaited: the first message may follow the connect at once.
    this.ports.set(portId, entry);
    entry.ready = (async () => {
      const background = this.backgrounds.get(id);
      let peers: PortEndpoint[] = [];
      if (call.tabId !== null && call.tabId !== undefined) {
        const view = this.host.viewOf(Number(call.tabId));
        if (view) peers = [{ view: new WeakRef(view), world: worldOf(id) }];
      } else if (background?.view === source.view) {
        peers = [...this.pageViews]
          .filter(([view, owner]) => owner === id && view !== source.view)
          .map(([view]) => ({ view: new WeakRef(view), world: null }));
      } else if (background) {
        await background.loaded;
        peers = [{ view: new WeakRef(background.view), world: null }];
      }
      entry.peers = peers;
      debug(
        'extension-api',
        `port ${portId} (${typeof call.name === 'string' ? call.name : ''}): background=${String(!!background)} loaded=${String(background ? await Promise.race([background.loaded.then(() => true), Promise.resolve('pending')]) : 'n/a')} peers=${String(peers.length)}`,
      );
      if (peers.length === 0) {
        this.ports.delete(portId);
        debug(
          'extension-api',
          `port ${portId}: no peer found, telling the origin it is disconnected`,
        );
        this.evalIn(
          entry.origin,
          `self.__wsExt && __wsExt.portDisconnect(${JSON.stringify(portId)});`,
        );
        return;
      }
      const sender = JSON.stringify(this.senderOf(extension, source));
      for (const peer of peers) {
        this.evalIn(
          peer,
          `self.__wsExt && __wsExt.portConnect(${JSON.stringify(portId)}, ${JSON.stringify(typeof call.name === 'string' ? call.name : '')}, ${sender});`,
        );
      }
    })();
    return entry.ready;
  }

  private async portPost(
    extension: LoadedExtension,
    source: RuntimeSource,
    call: ExtensionCall,
  ): Promise<void> {
    const portId = String(call.portId);
    const entry = this.ports.get(portId);
    if (entry?.extension !== extension.summary.id) return;
    await entry.ready;
    const script = `self.__wsExt && __wsExt.portMessage(${JSON.stringify(portId)}, ${JSON.stringify(call.message ?? null)});`;
    for (const side of this.otherSides(entry, source)) this.evalIn(side, script);
  }

  private portDisconnect(extension: LoadedExtension, source: RuntimeSource, portId: string): void {
    const entry = this.ports.get(portId);
    if (entry?.extension !== extension.summary.id) return;
    this.ports.delete(portId);
    const script = `self.__wsExt && __wsExt.portDisconnect(${JSON.stringify(portId)});`;
    for (const side of this.otherSides(entry, source)) this.evalIn(side, script);
  }

  /** A view went away or navigated: every port with an end in it is over. */
  private dropPortsOf(view: WebKit.WebView): void {
    for (const [portId, entry] of [...this.ports]) {
      const script = `self.__wsExt && __wsExt.portDisconnect(${JSON.stringify(portId)});`;
      if (entry.origin.view.deref() === view) {
        debug('extension-api', `dropPortsOf: ${portId} dropped, its origin view is going away`);
        this.ports.delete(portId);
        for (const peer of entry.peers) this.evalIn(peer, script);
      } else if (entry.peers.some((peer) => peer.view.deref() === view)) {
        debug(
          'extension-api',
          `dropPortsOf: ${portId} dropped, one of its peer views is going away`,
        );
        this.ports.delete(portId);
        this.evalIn(entry.origin, script);
      }
    }
  }

  // ── what happens in tabs, told to the background pages ─────────────────────────────────────
  private fireInBackgrounds(
    event: string,
    build: (extension: LoadedExtension) => unknown[] | null,
  ): void {
    for (const extension of this.service.active()) {
      const background = this.backgrounds.get(extension.summary.id);
      if (!background) continue;
      const args = build(extension);
      if (args === null) continue;
      background.view
        .evaluate_javascript(
          `self.__wsExt && __wsExt.fire(${JSON.stringify(event)}, ${JSON.stringify(args)});`,
          -1,
          null,
          null,
          null,
        )
        .catch(() => undefined);
    }
  }

  private navigated(view: WebKit.WebView, event: WebKit.LoadEvent): void {
    if (event === WebKit.LoadEvent.COMMITTED) {
      // Once a tab that was showing one of an extension's own pages commits a navigation elsewhere
      // (the user followed a link out of it, for instance), it goes back to being an ordinary page:
      // it may no longer read that extension's files (extension-scheme.ts's `own` check) or navigate
      // back into `webswitch-ext://` on its own (allowsTabNavigation).
      const id = this.tabExtension.get(view);
      if (id !== undefined && !(view.get_uri() ?? '').startsWith(`${EXTENSION_SCHEME}://${id}/`)) {
        this.tabExtension.delete(view);
      }
    }
    const tabId = this.host.tabIdOf(view);
    if (tabId === null || this.service.active().length === 0) return;
    const url = view.get_uri();
    const timeStamp = Date.now();
    const seen = (extension: LoadedExtension): string =>
      this.has(extension, 'tabs') || matchesAny(hostsOf(extension.manifest), url) ? url : '';
    const details = (extension: LoadedExtension): Record<string, unknown> => ({
      tabId,
      url: seen(extension),
      frameId: 0,
      parentFrameId: -1,
      processId: -1,
      timeStamp,
    });
    const tab = (extension: LoadedExtension): Record<string, unknown> | null =>
      this.queryTabs(extension, {}).find((item) => item.id === tabId) ?? null;
    const navigation = () => (extension: LoadedExtension) =>
      this.has(extension, 'webNavigation') ? [details(extension)] : null;
    if (event === WebKit.LoadEvent.STARTED) {
      this.fireInBackgrounds('webNavigation.onBeforeNavigate', navigation());
      this.fireInBackgrounds('tabs.onUpdated', (extension) => [
        tabId,
        { status: 'loading', ...(seen(extension) === '' ? {} : { url: seen(extension) }) },
        tab(extension),
      ]);
    } else if (event === WebKit.LoadEvent.COMMITTED) {
      this.dropPortsOf(view);
      this.fireInBackgrounds('webNavigation.onCommitted', (extension) =>
        this.has(extension, 'webNavigation')
          ? [{ ...details(extension), transitionType: 'link', transitionQualifiers: [] }]
          : null,
      );
    } else if (event === WebKit.LoadEvent.FINISHED) {
      this.fireInBackgrounds('webNavigation.onDOMContentLoaded', navigation());
      this.fireInBackgrounds('webNavigation.onCompleted', navigation());
      this.fireInBackgrounds('tabs.onUpdated', (extension) => [
        tabId,
        { status: 'complete' },
        tab(extension),
      ]);
    }
  }

  /** Tabs opened, closed or switched: `tabs.onCreated`, `onRemoved` and `onActivated`. */
  private tabsChanged(): void {
    if (this.service.active().length === 0) {
      this.knownTabs = new Set(this.host.listTabs().map((tab) => tab.id));
      this.activeTab = this.host.listTabs().find((tab) => tab.active)?.id ?? null;
      return;
    }
    const tabs = this.host.listTabs();
    const now = new Set(tabs.map((tab) => tab.id));
    for (const tab of tabs) {
      if (!this.knownTabs.has(tab.id)) {
        this.fireInBackgrounds('tabs.onCreated', (extension) => [
          this.queryTabs(extension, {}).find((item) => item.id === tab.id) ?? tab,
        ]);
      }
    }
    for (const id of this.knownTabs) {
      if (!now.has(id)) {
        this.fireInBackgrounds('tabs.onRemoved', () => [
          id,
          { windowId: 1, isWindowClosing: false },
        ]);
      }
    }
    // A page that changed its title or address is an update for the extensions that watch tabs.
    for (const tab of tabs) {
      const before = this.tabDetails.get(tab.id);
      if (before && (before.url !== tab.url || before.title !== tab.title)) {
        const changes: Record<string, string> = {};
        if (before.title !== tab.title) changes.title = tab.title;
        if (before.url !== tab.url) changes.url = tab.url;
        this.fireInBackgrounds('tabs.onUpdated', (extension) => {
          const seen = this.queryTabs(extension, {}).find((item) => item.id === tab.id);
          if (!seen) return null;
          const visible = seen.url !== '' || tab.url === '';
          return [tab.id, visible ? changes : {}, seen];
        });
      }
    }
    this.tabDetails = new Map(tabs.map((tab) => [tab.id, { url: tab.url, title: tab.title }]));
    const active = tabs.find((tab) => tab.active)?.id ?? null;
    if (active !== null && active !== this.activeTab) {
      this.fireInBackgrounds('tabs.onActivated', () => [{ tabId: active, windowId: 1 }]);
    }
    this.knownTabs = now;
    this.activeTab = active;
  }

  // ── storage ────────────────────────────────────────────────────────────────────────────────
  private areasOf(id: string): StorageAreas {
    let areas = this.storage.get(id);
    if (!areas) {
      areas = { local: {}, sync: {}, managed: {}, session: {} };
      try {
        const [, bytes] = GLib.file_get_contents(this.service.storagePath(id));
        const saved = JSON.parse(new TextDecoder().decode(bytes)) as {
          local?: Record<string, unknown>;
          sync?: Record<string, unknown>;
        };
        areas.local = saved.local ?? {};
        areas.sync = saved.sync ?? {};
      } catch {
        // Nothing stored yet.
      }
      this.storage.set(id, areas);
    }
    return areas;
  }

  private handleStorage(id: string, call: ExtensionCall): unknown {
    const name = String(call.area);
    const areas = this.areasOf(id);
    const area =
      name === 'local'
        ? areas.local
        : name === 'sync'
          ? areas.sync
          : name === 'session'
            ? areas.session
            : areas.managed;
    if (call.op === 'storage.get') {
      const keys = call.keys as null | string | string[] | Record<string, unknown>;
      if (keys === null) return { ...area };
      if (typeof keys === 'string') return keys in area ? { [keys]: area[keys] } : {};
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((key) => key in area).map((key) => [key, area[key]]));
      }
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [key, key in area ? area[key] : fallback]),
      );
    }
    if (name === 'managed') throw new Error('The managed storage is read only.');
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    if (call.op === 'storage.set') {
      for (const [key, value] of Object.entries(call.items as Record<string, unknown>)) {
        changes[key] = { oldValue: area[key], newValue: value };
        area[key] = value;
      }
    } else {
      const keys =
        call.op === 'storage.remove'
          ? ([] as string[]).concat(call.keys as string | string[])
          : Object.keys(area);
      for (const key of keys) {
        if (key in area) changes[key] = { oldValue: area[key] };
        Reflect.deleteProperty(area, key);
      }
    }
    if (name !== 'session') this.scheduleSave(id);
    if (Object.keys(changes).length > 0) this.broadcastStorage(id, changes, name);
    return undefined;
  }

  private scheduleSave(id: string): void {
    if (this.storageTimers.has(id)) return;
    this.storageTimers.add(id);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
      this.storageTimers.delete(id);
      const areas = this.storage.get(id);
      if (areas) {
        const text = JSON.stringify({ local: areas.local, sync: areas.sync });
        writeText(this.service.storagePath(id), text).catch((error: unknown) => {
          debug('extensions', `could not save the storage of ${id}: ${String(error)}`);
        });
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  /** Tells every part of the extension (its pages and its content scripts in tabs) that storage changed. */
  private broadcastStorage(id: string, changes: unknown, area: string): void {
    const script = `self.__wsExt && __wsExt.storageChanged(${JSON.stringify(changes)}, ${JSON.stringify(area)});`;
    for (const [view, owner] of this.pageViews) {
      if (owner === id)
        view.evaluate_javascript(script, -1, null, null, null).catch(() => undefined);
    }
    for (const ref of this.attached) {
      ref
        .deref()
        ?.evaluate_javascript(script, -1, worldOf(id), null, null)
        .catch(() => undefined);
    }
  }

  // ── messages between the parts of an extension ─────────────────────────────────────────────
  /** From a content script or a page to the background page, or from the background to the other pages. */
  private async route(
    extension: LoadedExtension,
    source: RuntimeSource,
    message: unknown,
  ): Promise<unknown> {
    const { id } = extension.summary;
    const sender = this.senderOf(extension, source);
    const background = this.backgrounds.get(id);
    const fromBackground = background?.view === source.view;
    let targets: WebKit.WebView[] = [];
    if (fromBackground) {
      targets = [...this.pageViews]
        .filter(([view, owner]) => owner === id && view !== source.view)
        .map(([view]) => view);
    } else if (background) {
      await background.loaded;
      targets = [background.view];
    }
    for (const view of targets) {
      const answer = await this.deliver(view, null, message, sender);
      if (!answer.empty) return answer.response;
    }
    return undefined;
  }

  private async sendToTab(
    extension: LoadedExtension,
    tabId: number,
    message: unknown,
    source: RuntimeSource,
  ): Promise<unknown> {
    const view = this.host.viewOf(tabId);
    if (!view) throw new Error(`No tab with id ${String(tabId)}.`);
    const answer = await this.deliver(
      view,
      worldOf(extension.summary.id),
      message,
      this.senderOf(extension, source),
    );
    return answer.empty ? undefined : answer.response;
  }

  private deliver(
    view: WebKit.WebView,
    world: string | null,
    message: unknown,
    sender: unknown,
  ): Promise<{ response: unknown; empty: boolean }> {
    return this.request(
      view,
      world,
      (callId) =>
        `self.__wsExt && __wsExt.deliver(${String(callId)}, ${JSON.stringify(message ?? null)}, ${JSON.stringify(sender)});`,
    );
  }

  /** Runs a script that answers later through `runtime.respond` with its call id; gives up after a while. */
  private request(
    view: WebKit.WebView,
    world: string | null,
    scriptFor: (callId: number) => string,
    seconds = ANSWER_TIMEOUT_S,
  ): Promise<{ response: unknown; empty: boolean }> {
    const callId = this.nextCall++;
    return new Promise((resolve) => {
      const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
        this.waiting.delete(callId);
        resolve({ response: null, empty: true });
        return GLib.SOURCE_REMOVE;
      });
      this.waiting.set(callId, (answer) => {
        GLib.source_remove(timer);
        resolve(answer);
      });
      view.evaluate_javascript(scriptFor(callId), -1, world, null, null).catch(() => {
        this.waiting.get(callId)?.({ response: null, empty: true });
        this.waiting.delete(callId);
      });
    });
  }

  // ── tabs and scripting ─────────────────────────────────────────────────────────────────────
  private queryTabs(
    extension: LoadedExtension,
    query: Record<string, unknown>,
  ): Record<string, unknown>[] {
    const hosts = hostsOf(extension.manifest);
    const wanted =
      query.url === undefined ? null : ([] as string[]).concat(query.url as string | string[]);
    const title =
      typeof query.title === 'string'
        ? new RegExp(`^${query.title.split('*').map(escapeRegex).join('.*')}$`)
        : null;
    return (
      this.host
        .listTabs()
        .filter((tab) => query.active === undefined || tab.active === query.active)
        .filter((tab) => wanted === null || matchesAny(wanted, tab.url))
        .filter((tab) => title === null || title.test(tab.title))
        .map((tab) => this.tabObject(tab))
        .filter((tab) => query.status === undefined || tab.status === query.status)
        // Without the tabs permission an extension only sees the address of pages it may run on.
        .map((tab) =>
          this.has(extension, 'tabs') || matchesAny(hosts, String(tab.url))
            ? tab
            : { ...tab, url: '', title: '' },
        )
    );
  }

  /** The view of the tab an injection targets, once the extension is known to be allowed there. */
  private tabView(
    extension: LoadedExtension,
    injection: Record<string, unknown>,
    scripting: boolean,
  ): WebKit.WebView {
    if (scripting) this.require(extension, 'scripting');
    const tabId = Number((injection.target as { tabId?: number } | undefined)?.tabId);
    const view = this.host.viewOf(tabId);
    if (!view) throw new Error('No such tab.');
    const url = view.get_uri();
    if (!matchesAny(hostsOf(extension.manifest), url) && !this.has(extension, 'activeTab')) {
      throw new Error('The extension has no access to that page.');
    }
    return view;
  }

  private filesOf(extension: LoadedExtension, injection: Record<string, unknown>): string {
    return ((injection.files as string[] | undefined) ?? [])
      .map((path) => this.readSource(extension, path) ?? '')
      .join('\n;');
  }

  private async executeScript(
    extension: LoadedExtension,
    injection: Record<string, unknown>,
    scripting: boolean,
  ): Promise<unknown> {
    const view = this.tabView(extension, injection, scripting);
    const world = injection.world === 'MAIN' ? null : worldOf(extension.summary.id);
    // A page that is still loading has not had the extension's API put in its world yet.
    const shim = world === null ? '' : `${buildShim(this.shimConfig(extension, 'content'))}\n;`;
    if (typeof injection.func === 'string') {
      // A `func` injection is always a single expression (a function call), unlike `code`/`files`
      // below (arbitrary statements) — and it is very often async (Ghostery's own
      // `analyzePageStructure`, run on every tab, is one). `evaluate_javascript` does not itself
      // wait for the Promise such a call returns (see the GJS gotcha in CLAUDE.md): it hands back
      // the Promise object as soon as the call returns, which WebKit then refuses to serialize
      // ("Unsupported result type"), so the extension never sees a result — confirmed as the real
      // cause of "youtube.com loads with an empty feed the first time" reported by the user: their
      // own log showed exactly that error, from exactly this call, on every fresh tab. Real Chrome
      // always awaits a promise a `func` returns before resolving `executeScript`, so the call
      // settles its own result on `self` here and the caller polls for it, the same way
      // selftest.ts's `evaluate` does.
      const call = `(${injection.func})(...${JSON.stringify(injection.args ?? [])})`;
      const key = `__wsExec${String(this.nextCall++)}`;
      await view.evaluate_javascript(
        `${shim}Promise.resolve().then(() => (${call})).then(
           (value) => { self.${key} = JSON.stringify({ ok: true, value }); },
           (error) => { self.${key} = JSON.stringify({ ok: false, error: String((error && error.message) || error) }); },
         ); 0`,
        -1,
        world,
        null,
        null,
      );
      let text: string | null = null;
      for (let waited = 0; waited < EXEC_SCRIPT_TIMEOUT_MS; waited += EXEC_SCRIPT_POLL_MS) {
        const value = await view.evaluate_javascript(`self.${key} ?? null`, -1, world, null, null);
        if (!value.is_null()) {
          text = value.to_string();
          break;
        }
        await wait(EXEC_SCRIPT_POLL_MS);
      }
      await view
        .evaluate_javascript(`delete self.${key};`, -1, world, null, null)
        .catch(() => undefined);
      if (text === null) throw new Error('The injected script did not settle in time.');
      const settled = JSON.parse(text) as { ok: boolean; value?: unknown; error?: string };
      if (!settled.ok) throw new Error(settled.error ?? 'The injected script failed.');
      return [{ frameId: 0, result: settled.value }];
    }
    // `code`/`files` may be several statements, not one expression, so they are evaluated exactly
    // as given, like `eval`: the result is whatever its own last expression completes to. Unlike
    // `func`, this is not wrapped to await a promise — most such scripts run only for their side
    // effects, and wrapping arbitrary statements in an expression broke on anything but the
    // simplest one-liners (`SyntaxError: Unexpected token ';'`, tried and reverted).
    const code =
      typeof injection.code === 'string' ? injection.code : this.filesOf(extension, injection);
    const value = await view.evaluate_javascript(`${shim}${code}`, -1, world, null, null);
    const text = value.is_undefined() ? null : value.to_json(0);
    return [{ frameId: 0, result: text === null ? undefined : (JSON.parse(text) as unknown) }];
  }

  private async insertCss(
    extension: LoadedExtension,
    injection: Record<string, unknown>,
    scripting: boolean,
  ): Promise<unknown> {
    const view = this.tabView(extension, injection, scripting);
    const css =
      typeof injection.css === 'string' ? injection.css : this.filesOf(extension, injection);
    await view.evaluate_javascript(
      `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).append(s); })();`,
      -1,
      null,
      null,
      null,
    );
    return undefined;
  }

  /** `chrome.tabs.captureVisibleTab`: the active tab as a PNG data address. */
  private async capture(extension: LoadedExtension): Promise<string> {
    const active = this.host.listTabs().find((tab) => tab.active);
    const view = active ? this.host.viewOf(active.id) : null;
    if (!active || !view) throw new Error('No active web page to capture.');
    if (!matchesAny(hostsOf(extension.manifest), active.url) && !this.has(extension, 'activeTab')) {
      throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
    }
    const texture = await view.get_snapshot(
      WebKit.SnapshotRegion.VISIBLE,
      WebKit.SnapshotOptions.NONE,
      null,
    );
    return `data:image/png;base64,${GLib.base64_encode(texture.save_to_png_bytes().toArray())}`;
  }

  // ── fetch, for the hosts the extension declared ────────────────────────────────────────────
  private async fetchFor(extension: LoadedExtension, call: ExtensionCall): Promise<unknown> {
    const url = String(call.url);
    if (!/^https?:/i.test(url) || !matchesAny(hostsOf(extension.manifest), url)) {
      throw new Error('The extension has no permission for that address.');
    }
    const body = typeof call.body === 'string' ? GLib.base64_decode(call.body) : null;
    debug(
      'extension-api',
      `fetch request ${url.slice(0, 80)} headers ${JSON.stringify(call.headers)} body ${body === null ? 'none' : String(body.length)} bytes`,
    );
    // A browser always names itself; some servers answer differently to a request that does not.
    this.userAgent ??= new WebKit.Settings().get_user_agent();
    const answer = await this.http.request(
      typeof call.method === 'string' ? call.method : 'GET',
      url,
      {
        'user-agent': this.userAgent,
        'accept-language': 'en-US,en;q=0.9',
        ...((call.headers ?? {}) as Record<string, string>),
      },
      body,
      MAX_FETCH_BYTES,
    );
    debug(
      'extension-api',
      `fetch ${typeof call.method === 'string' ? call.method : 'GET'} ${url.slice(0, 120)} -> ${String(answer.status)} (${String(answer.body.length)} bytes)`,
    );
    return {
      status: answer.status,
      statusText: answer.statusText,
      headers: answer.headers,
      body: GLib.base64_encode(answer.body),
    };
  }

  // ── popup size ─────────────────────────────────────────────────────────────────────────────
  private sizePopup(width: number, height: number): void {
    const child = this.popover?.get_child();
    if (!child || !Number.isFinite(width) || !Number.isFinite(height)) return;
    child.set_size_request(
      Math.min(POPUP_MAX.width, Math.max(POPUP_MIN.width, Math.ceil(width))),
      Math.min(POPUP_MAX.height, Math.max(POPUP_MIN.height, Math.ceil(height))),
    );
  }
}
