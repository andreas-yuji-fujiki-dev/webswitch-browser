import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import type Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';
import { debug } from '../../core/debug';
import { isWebUrl, parseUrl } from '../../core/url';
import type { EmbedSpec } from '~types/browsers';
import type { Unsubscribe } from '~types/common';
import type { TabBrief } from '~types/extensions';
import type {
  CreateTabOptions,
  InternalPage,
  Tab,
  TabEmbed,
  TabState,
  TabsServiceDeps,
  TabsState,
} from '~types/tabs';

const MAX_CLOSED_TABS = 25;
const ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];
const DEFAULT_ZOOM_INDEX = 7;
const TITLE_SETTLE_MS = 400;
const EMBED_TITLE_WAIT_MS = 8000;
const NO_OPENER = GLib.getenv('WEBSWITCH_NO_OPENER');
const DEFAULT_WIDTH = 100;
const DEFAULT_HEIGHT = 100;
const MIDDLE_BUTTON = 2;
const PAGE_TITLES: Record<InternalPage, string> = {
  keybindings: 'Keybindings',
  history: 'History',
  cookies: 'Cookies',
  settings: 'General settings',
  themes: 'Themes',
  browsers: 'Test in other browsers',
  'dev-settings': 'Dev settings',
  extensions: 'Extensions',
};
// A `create` handler that refuses to open a window returns NULL, which the typings do not allow.
const NO_WINDOW = null as unknown as Gtk.Widget;

function loadEventName(event: WebKit.LoadEvent): string {
  return ['STARTED', 'REDIRECTED', 'COMMITTED', 'FINISHED'][event] ?? String(event);
}

/** GJS has no name lookup for this enum, so the reasons are spelled out. */
function terminationReason(reason: WebKit.WebProcessTerminationReason): string {
  switch (reason) {
    case WebKit.WebProcessTerminationReason.CRASHED:
      return 'the web process crashed';
    case WebKit.WebProcessTerminationReason.EXCEEDED_MEMORY_LIMIT:
      return 'the web process used too much memory';
    case WebKit.WebProcessTerminationReason.TERMINATED_BY_API:
      return 'the web process was closed by the browser';
    default:
      return 'the web process ended unexpectedly';
  }
}

/** The single source of truth for tabs. The UI only mirrors the state emitted from here. */
export class TabsService {
  private readonly tabs = new Map<number, Tab>();
  private readonly listeners = new Set<(state: TabsState) => void>();
  private readonly closedUrls: string[] = [];
  private activeTabId: number | null = null;
  private nextTabId = 1;
  private notifyScheduled = false;

  constructor(private readonly deps: TabsServiceDeps) {}

  getState(): TabsState {
    return {
      tabs: [...this.tabs.values()].map((tab) => this.snapshot(tab)),
      activeTabId: this.activeTabId,
    };
  }

  onStateChanged(listener: (state: TabsState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  createTab(url?: string, options: CreateTabOptions = {}): number {
    const { activate = true } = options;
    const view = options.view ?? this.deps.createView();
    const tab: Tab = {
      id: this.nextTabId++,
      view,
      pendingUrl: options.view?.get_uri() ?? null,
      failedUrl: null,
      error: null,
      page: options.page ?? null,
      zoomIndex: DEFAULT_ZOOM_INDEX,
      embed: null,
    };
    this.tabs.set(tab.id, tab);
    this.deps.stack.add_named(view, String(tab.id));
    this.bindTabEvents(tab);

    if (url) this.loadUrl(tab.id, url);
    if (activate || this.activeTabId === null) {
      this.activateTab(tab.id);
    } else {
      this.scheduleNotify();
    }
    return tab.id;
  }

  closeTab(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;

    const ids = [...this.tabs.keys()];
    const index = ids.indexOf(id);
    const { url } = this.snapshot(tab);
    if (url !== '' && tab.page === null) {
      this.closedUrls.push(url);
      if (this.closedUrls.length > MAX_CLOSED_TABS) this.closedUrls.shift();
    }
    this.releaseEmbed(tab);
    this.tabs.delete(id);
    if (tab.view.get_parent() === this.deps.stack) this.deps.stack.remove(tab.view);
    // Frees the web process and the signal handlers; done after the current signal has returned.
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      tab.view.run_dispose();
      return GLib.SOURCE_REMOVE;
    });

    if (this.tabs.size === 0) {
      this.activeTabId = null;
      this.createTab();
      return;
    }
    if (this.activeTabId === id) {
      const remaining = [...this.tabs.keys()];
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next !== undefined) this.activateTab(next);
    } else {
      this.scheduleNotify();
    }
  }

  closeActiveTab(): void {
    if (this.activeTabId !== null) this.closeTab(this.activeTabId);
  }

  activateTab(id: number): void {
    if (!this.tabs.has(id)) return;
    this.activeTabId = id;
    this.deps.stack.set_visible_child_name(String(id));
    this.applyVisibility();
    this.focusContent();
    this.scheduleNotify();
  }

  cycleTab(offset: 1 | -1): void {
    const ids = [...this.tabs.keys()];
    if (ids.length < 2 || this.activeTabId === null) return;
    const index = ids.indexOf(this.activeTabId);
    const next = ids[(index + offset + ids.length) % ids.length];
    if (next !== undefined) this.activateTab(next);
  }

  /** Debugging: a command for the X11 helper of the active tab's embedded window. */
  probeEmbed(line: string): Promise<string> {
    return this.getActiveTab()?.embed?.handle.probe(line) ?? Promise.resolve('no embedded window');
  }

  /** Runs `apply` on every tab's web view (settings that change while the browser runs). */
  forEachView(apply: (view: WebKit.WebView) => void): void {
    for (const tab of this.tabs.values()) apply(tab.view);
  }

  /** The tabs as an extension may see them (the ones that show a web page). */
  briefs(): TabBrief[] {
    return [...this.tabs.values()]
      .filter((tab) => tab.page === null)
      .map((tab, index) => {
        const state = this.snapshot(tab);
        return {
          id: tab.id,
          url: state.url,
          title: state.title,
          active: tab.id === this.activeTabId,
          index,
          windowId: 1,
        };
      });
  }

  /** The addresses of tabs closed recently, newest first. */
  recentlyClosed(): string[] {
    return [...this.closedUrls].reverse();
  }

  idOfView(view: WebKit.WebView): number | null {
    return [...this.tabs.values()].find((tab) => tab.view === view)?.id ?? null;
  }

  /** The page itself answered, just with an error status: shown instead of the server's own page.
   * `url` is passed in rather than read from the view, whose own URI has not committed yet at the
   * point (response headers received) this is reported from. */
  reportHttpError(view: WebKit.WebView, url: string, status: number): void {
    const tab = [...this.tabs.values()].find((entry) => entry.view === view);
    if (!tab) return;
    tab.failedUrl = url;
    tab.error = { code: status, description: `HTTP ${String(status)}`, httpStatus: status };
    this.scheduleNotify();
  }

  viewOfTab(id: number): WebKit.WebView | null {
    const tab = this.tabs.get(id);
    return tab?.page === null ? tab.view : null;
  }

  reloadTab(id: number): void {
    this.viewOfTab(id)?.reload();
  }

  /** Shows a built-in page, reusing the tab that already shows it. */
  openPage(page: InternalPage): void {
    const existing = [...this.tabs.values()].find((tab) => tab.page === page);
    if (existing) {
      this.activateTab(existing.id);
    } else {
      this.createTab(undefined, { page });
    }
  }

  reopenClosedTab(): void {
    const url = this.closedUrls.pop();
    if (url !== undefined) this.createTab(url);
  }

  /** 1-based position in the tab strip. Out-of-range positions are ignored. */
  activateTabAtPosition(position: number): void {
    const id = [...this.tabs.keys()][position - 1];
    if (id !== undefined) this.activateTab(id);
  }

  activateLastTab(): void {
    const id = [...this.tabs.keys()].at(-1);
    if (id !== undefined) this.activateTab(id);
  }

  zoomActiveTab(change: 'in' | 'out' | 'reset'): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    const step = change === 'in' ? 1 : change === 'out' ? -1 : 0;
    tab.zoomIndex =
      change === 'reset'
        ? DEFAULT_ZOOM_INDEX
        : Math.min(ZOOM_LEVELS.length - 1, Math.max(0, tab.zoomIndex + step));
    tab.view.set_zoom_level(ZOOM_LEVELS[tab.zoomIndex] ?? 1);
  }

  loadUrl(id: number, url: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    // A DRM page takes over this tab when an embedded Chromium is available, else it goes to the
    // app-window hand-off. Any other page first releases the tab from an embedded window.
    if (this.deps.needsDrm(url) && this.embedInto(tab, url)) return;
    if (this.deps.handOff(url)) return;
    this.releaseEmbed(tab);
    tab.pendingUrl = url;
    tab.failedUrl = null;
    tab.error = null;
    tab.page = null;
    // A cookie that is only allowed on this site must be back in the browser before the request.
    if (this.deps.needsCookiePrep(url)) {
      void this.deps.prepareCookies(url).then(() => {
        if (this.tabs.get(id) === tab && tab.pendingUrl === url) tab.view.load_uri(url);
      });
    } else {
      tab.view.load_uri(url);
    }
    this.scheduleNotify();
  }

  /**
   * Shows a DRM page with an embedded Chromium window. It takes over the tab that was navigating
   * (`source`), or opens a new tab when the page was opened from nowhere. False when not available.
   */
  openEmbedded(url: string, source?: WebKit.WebView): boolean {
    if (!this.deps.needsDrm(url)) return false;
    const owner = source && [...this.tabs.values()].find((tab) => tab.view === source);
    if (owner) return this.embedInto(owner, url);
    const id = this.createTab();
    const tab = this.tabs.get(id);
    if (tab && this.embedInto(tab, url)) return true;
    this.closeTab(id);
    return false;
  }

  /** Shows `url` in a browser installed for testing, inside a new tab. False when it cannot start. */
  openInBrowser(url: string, spec: EmbedSpec): boolean {
    const id = this.createTab();
    const tab = this.tabs.get(id);
    if (tab && this.embedInto(tab, url, spec)) return true;
    this.closeTab(id);
    return false;
  }

  private embedInto(tab: Tab, url: string, spec?: EmbedSpec): boolean {
    const handle = spec
      ? this.deps.attachBrowser(tab.view, spec)
      : this.deps.attachEmbed(tab.view, url);
    if (!handle) return false;
    this.releaseEmbed(tab);
    // Whatever the tab showed stops: a page left running underneath would keep playing.
    const current = tab.view.get_uri() ?? '';
    if (current !== '' && current !== 'about:blank') tab.view.load_uri('about:blank');
    const host = parseUrl(url)?.host ?? url;
    const embed: TabEmbed = { handle, url, title: '', label: spec?.label ?? '' };
    tab.embed = embed;
    tab.page = null;
    tab.error = null;
    tab.failedUrl = null;
    tab.pendingUrl = null;

    // The history gets the page once Chrome has told us its title (or after a while without one).
    let recorded = false;
    const record = (title: string): void => {
      if (recorded || tab.embed !== embed) return;
      recorded = true;
      // A page opened in another browser to test it is not a visit of Webswitch's own.
      if (spec) return;
      this.deps.onPageVisit({ url, title: title || host });
    };
    handle.onTitle((title) => {
      if (tab.embed !== embed || title === embed.title) return;
      embed.title = title;
      record(title);
      this.scheduleNotify();
    });
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, EMBED_TITLE_WAIT_MS, () => {
      record('');
      return GLib.SOURCE_REMOVE;
    });
    handle.onClosed(() => {
      if (tab.embed === embed) this.closeTab(tab.id);
    });
    this.scheduleNotify();
    return true;
  }

  private releaseEmbed(tab: Tab): void {
    tab.embed?.handle.close();
    tab.embed = null;
  }

  getActiveView(): WebKit.WebView | null {
    return this.getActiveTab()?.view ?? null;
  }

  getActiveTabId(): number | null {
    return this.activeTabId;
  }

  /** Puts keyboard focus where the user expects it: the page, or the address bar on a blank tab. */
  focusContent(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    if (tab.page !== null) {
      // Built-in pages are drawn by the UI itself.
      this.deps.focusUi();
    } else if (tab.embed) {
      tab.embed.handle.focus();
    } else if (this.isContentVisible(tab)) {
      tab.view.grab_focus();
    } else if (!tab.error) {
      this.deps.focusAddressBar();
    }
  }

  toggleDevTools(): void {
    const view = this.getActiveView();
    if (!view) return;
    const tab = this.getActiveTab();
    debug(
      'devtools',
      `toggle: page=${tab?.page ?? 'web'} embedded=${tab?.embed != null} extras=${view.get_settings().enable_developer_extras}`,
    );
    // A built-in page, the home page (a blank tab) and a load error are drawn by the UI: the tab's
    // own web view is hidden then, and WebKit gives an inspector for a hidden view a window of its
    // own instead of docking it. So the UI is what gets inspected.
    if (tab?.page || !this.deps.stack.get_visible()) {
      this.deps.toggleUiDevTools(tab?.id ?? -1);
      return;
    }
    if (this.deps.useChromeDevTools()) {
      this.deps.toggleChromeDevTools(view, tab?.id ?? -1);
      return;
    }
    const inspector = view.get_inspector();
    if (inspector.get_web_view()) {
      inspector.close();
    } else {
      inspector.show();
    }
  }

  private getActiveTab(): Tab | undefined {
    return this.activeTabId === null ? undefined : this.tabs.get(this.activeTabId);
  }

  private bindTabEvents(tab: Tab): void {
    const view = tab.view;
    this.deps.watchInspector(view);
    const isLive = (): boolean => this.tabs.has(tab.id);
    const changed = (): void => {
      if (isLive()) this.scheduleNotify();
    };
    // See the "preloader" retry in the load-failed handler below.
    let retriedFrom: string | null = null;

    view.connect('notify::title', changed);
    view.connect('notify::uri', changed);
    view.connect('notify::is-loading', changed);
    view.get_back_forward_list().connect('changed', changed);

    view.connect('load-changed', (_view, event) => {
      if (!isLive()) return;
      debug('load', `tab ${tab.id} ${loadEventName(event)} ${view.get_uri() ?? ''}`);
      if (event === WebKit.LoadEvent.STARTED || event === WebKit.LoadEvent.REDIRECTED) {
        if (this.deps.handOff(view.get_uri() ?? '', view)) {
          // Another program plays this page; the tab stays where it was.
          view.stop_loading();
          tab.pendingUrl = null;
          this.scheduleNotify();
          return;
        }
        tab.pendingUrl = view.get_uri();
        tab.failedUrl = null;
        tab.error = null;
      } else if (event === WebKit.LoadEvent.COMMITTED) {
        tab.pendingUrl = null;
      } else {
        tab.pendingUrl = null;
        // A load that actually finished clears the retry guard, so a later, unrelated failure of
        // the same address still gets its own one-time retry.
        retriedFrom = null;
        if (!tab.error && tab.page === null) this.recordVisit(tab);
      }
      this.scheduleNotify();
    });

    view.connect('load-failed', (_view, _event, failingUri, error) => {
      if (!isLive()) return true;
      // A navigation replaced by another one, or handled elsewhere (a download), is not an error.
      if (
        error.matches(WebKit.NetworkError.quark(), WebKit.NetworkError.CANCELLED) ||
        error.matches(
          WebKit.PolicyError.quark(),
          WebKit.PolicyError.FRAME_LOAD_INTERRUPTED_BY_POLICY_CHANGE,
        )
      ) {
        return true;
      }
      // A WebKit quirk seen on the very first navigation of a real, signed-in session: the main
      // document's own preconnected/preloaded request is cancelled ("Request canceled from
      // preloader") even though the exact same address loads cleanly right after — reported by the
      // user, who always had to reload by hand to recover, never twice in a row. One silent,
      // automatic retry does what they were already doing manually; a second failure of the same
      // address still shows the real error page instead of retrying forever.
      if (error.message.includes('preloader') && retriedFrom !== failingUri) {
        retriedFrom = failingUri;
        debug('load-failed', `tab ${tab.id} ${failingUri}  ${error.message} — retrying once`);
        view.load_uri(failingUri);
        return true;
      }
      debug('load-failed', `tab ${tab.id} ${failingUri}  ${error.message} (code ${error.code})`);
      tab.failedUrl = failingUri;
      tab.error = { code: error.code, description: error.message };
      this.scheduleNotify();
      return true;
    });

    view.connect('web-process-terminated', (_view, reason) => {
      if (!isLive() || reason === WebKit.WebProcessTerminationReason.TERMINATED_BY_API) return;
      debug('crash', `tab ${tab.id} ${view.get_uri() ?? ''}  ${terminationReason(reason)}`);
      tab.error = {
        code: 0,
        description: `The page crashed (${terminationReason(reason)})`,
      };
      this.scheduleNotify();
    });

    view.connect('create', (_view, action) => this.handleCreate(view, action));
    view.connect('close', () => {
      this.closeTab(tab.id);
    });
    view.connect('enter-fullscreen', () => {
      this.deps.setContentFullscreen(true);
      return false;
    });
    view.connect('leave-fullscreen', () => {
      this.deps.setContentFullscreen(false);
      return false;
    });
  }

  /**
   * Links and `window.open(url)` become tabs. `window.open` with a size (the shape of every OAuth
   * sign-in) is a real popup and stays linked to its opener. Only web pages may be opened.
   */
  private handleCreate(source: WebKit.WebView, action: WebKit.NavigationAction): Gtk.Widget {
    const uri = action.get_request().get_uri() ?? '';
    debug('new-window', `${uri}  from ${source.get_uri() ?? ''}`);
    if (!(isWebUrl(uri) || uri === 'about:blank' || uri === '')) return NO_WINDOW;
    if (this.deps.handOff(uri)) return NO_WINDOW;

    const background =
      action.get_mouse_button() === MIDDLE_BUTTON ||
      (action.get_modifiers() & Gdk.ModifierType.CONTROL_MASK) !== 0;
    // A clicked link with a target opens as an ordinary tab, unrelated to the page (browsers treat
    // target=_blank as noopener). Only a script's window.open keeps `window.opener`, which sign-in
    // popups need. WEBSWITCH_NO_OPENER=all (diagnosis) unrelates every new page, popups included.
    const clicked = action.get_navigation_type() === WebKit.NavigationType.LINK_CLICKED;
    if (uri !== '' && uri !== 'about:blank' && (clicked || NO_OPENER === 'all')) {
      debug('new-window', `opened as an independent tab (no opener)`);
      this.createTab(uri, { activate: !background });
      return NO_WINDOW;
    }

    const created = this.deps.createView(source);
    let shown = false;
    created.connect('ready-to-show', () => {
      // WebKit can announce the same window again (the page keeps configuring it); adding one view
      // as two tabs would leave the second tab pointing at a view the first one destroyed.
      if (shown) return;
      shown = true;
      const { width, height } = created.get_window_properties().get_geometry();
      // WebKit reports 100x100 when the page asked for no size (a plain link); a real popup has one.
      const wantsSize =
        width > 0 && height > 0 && !(width === DEFAULT_WIDTH && height === DEFAULT_HEIGHT);
      if (wantsSize) {
        this.deps.openPopup(created);
      } else {
        this.createTab(undefined, { view: created, activate: !background });
      }
    });
    return created;
  }

  /** The title only reaches WebKit's view a moment after the page finishes loading, so wait for it. */
  private recordVisit(tab: Tab): void {
    const url = tab.view.get_uri() ?? '';
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, TITLE_SETTLE_MS, () => {
      // The tab may have been closed, or moved on to another page, in the meantime.
      if (this.tabs.has(tab.id) && !tab.error && tab.view.get_uri() === url) {
        this.deps.onPageVisit({ url, title: tab.view.get_title() ?? '' });
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  private snapshot(tab: Tab): TabState {
    if (tab.page !== null) {
      return {
        id: tab.id,
        title: PAGE_TITLES[tab.page],
        url: `webswitch://${tab.page}`,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
        page: tab.page,
      };
    }
    if (tab.embed) {
      return {
        id: tab.id,
        title: `${tab.embed.label ? `${tab.embed.label} · ` : ''}${tab.embed.title || (parseUrl(tab.embed.url)?.host ?? tab.embed.url)}`,
        url: tab.embed.url,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
        page: null,
      };
    }
    const view = tab.view;
    const url = tab.failedUrl ?? tab.pendingUrl ?? view.get_uri() ?? '';
    return {
      id: tab.id,
      title: view.get_title() ?? '',
      url: url === 'about:blank' ? '' : url,
      loading: view.is_loading,
      canGoBack: view.can_go_back(),
      canGoForward: view.can_go_forward(),
      error: tab.error,
      page: null,
    };
  }

  /** A blank or failed tab hides the page area so the UI's own background shows through. */
  private isContentVisible(tab: Tab): boolean {
    if (tab.id !== this.activeTabId || tab.error || tab.page !== null) return false;
    if (tab.embed) return true;
    const url = tab.pendingUrl ?? tab.view.get_uri() ?? '';
    return url !== '' && url !== 'about:blank';
  }

  private applyVisibility(): void {
    const active = this.getActiveTab();
    this.deps.stack.set_visible(active !== undefined && this.isContentVisible(active));
  }

  /** Coalesces bursts of view events into one visibility update and one broadcast. */
  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    // GJS has no queueMicrotask; a resolved promise runs its callback at the same point.
    void Promise.resolve().then(() => {
      this.notifyScheduled = false;
      this.applyVisibility();
      const state = this.getState();
      for (const listener of this.listeners) listener(state);
    });
  }
}
