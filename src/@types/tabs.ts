import type Gtk from 'gi://Gtk?version=4.0';
import type WebKit from 'gi://WebKit?version=6.0';
import type { EmbedHandle } from './drm';
import type { HistoryVisit } from './history';

/** Pages the browser draws itself instead of loading from the web. */
export type InternalPage = 'keybindings' | 'history' | 'cookies';

export interface TabError {
  code: number;
  description: string;
}

/** What the UI is allowed to know about a tab. */
export interface TabState {
  id: number;
  title: string;
  /** Empty string for a blank tab. While a navigation is pending, this is the pending URL. */
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: TabError | null;
  /** Set when the tab shows a built-in page. The UI draws it in the page area. */
  page: InternalPage | null;
}

export interface TabsState {
  tabs: TabState[];
  activeTabId: number | null;
}

/** Native bookkeeping for one tab. Never leaves the native side. */
export interface Tab {
  id: number;
  view: WebKit.WebView;
  pendingUrl: string | null;
  /** The address that failed to load, kept for the error message (the view still shows the last good page). */
  failedUrl: string | null;
  error: TabError | null;
  page: InternalPage | null;
  zoomIndex: number;
  /** Set while a Chromium window is embedded over this tab (DRM sites, experimental). */
  embed: TabEmbed | null;
}

/** What the tab shows while a Chromium window is embedded in it. */
export interface TabEmbed {
  handle: EmbedHandle;
  url: string;
  /** The embedded window's title once Chrome has one; empty until then. */
  title: string;
}

export interface CreateTabOptions {
  /** Defaults to true. Background tabs (ctrl+click) pass false. */
  activate?: boolean;
  /** Opens a built-in page instead of a web page. */
  page?: InternalPage;
  /** A view WebKit already created for this tab (`window.open`), which keeps `window.opener`. */
  view?: WebKit.WebView;
}

export interface TabsServiceDeps {
  /** Where the page views live: the content area under the browser chrome. */
  stack: Gtk.Stack;
  /** Creates a hardened web view for a tab (optionally related to the page that opened it). */
  createView: (related?: WebKit.WebView) => WebKit.WebView;
  /** Puts keyboard focus in the address bar of the UI. */
  focusAddressBar: () => void;
  /** Puts keyboard focus in the UI, for tabs that show a built-in page. */
  focusUi: () => void;
  /** Called when a web page finishes loading in a tab, for the history. */
  onPageVisit: (visit: HistoryVisit) => void;
  /** Lets a page's popup (`window.open` with features) live in its own small window. */
  openPopup: (view: WebKit.WebView) => void;
  /** True when a cookie that is only allowed on `url`'s site has to be restored before loading it. */
  needsCookiePrep: (url: string) => boolean;
  /** Restores those cookies; resolves when the browser has them. */
  prepareCookies: (url: string) => Promise<void>;
  /** True for pages that need DRM, which this engine cannot play. */
  needsDrm: (url: string) => boolean;
  /** Embeds a Chromium window over `view` showing `url`; null when embedding is not available. */
  attachEmbed: (view: WebKit.WebView, url: string) => EmbedHandle | null;
  /**
   * Offered every page a tab is about to load. Returns true when another program took it (DRM
   * sites). `source` is the view that was navigating, so the page can take over that same tab.
   */
  handOff: (url: string, source?: WebKit.WebView) => boolean;
  /** Called when a tab asks for HTML fullscreen (a video), so the chrome can get out of the way. */
  setContentFullscreen: (fullscreen: boolean) => void;
}
