import type { EmbedSpec } from './browsers';
import type Gtk from 'gi://Gtk?version=4.0';
import type WebKit from 'gi://WebKit?version=6.0';
import type { EmbedHandle } from './drm';
import type { HistoryVisit } from './history';

/** Pages the browser draws itself instead of loading from the web. */
export type InternalPage =
  | 'keybindings'
  | 'history'
  | 'cookies'
  | 'settings'
  | 'themes'
  | 'dev-settings'
  | 'browsers'
  | 'extensions';

export interface TabError {
  code: number;
  description: string;
  /** The real HTTP status the server sent (a page that answered, just with an error status — 404,
   * 403, 500...), when there was one. Not set for a network-level failure (no connection, DNS,
   * cancelled): those have no status to show, only `code`/`description`. */
  httpStatus?: number;
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
  /** Set while this tab is on one extension's own page on the real Chrome Web Store, so the UI can
   * offer to install it directly instead of the store's own "Add to Chrome" button, which has
   * nothing to talk to in a non-Chrome browser. */
  storeId: string | null;
  /** Pinned tabs are kept first in the strip (see `TabsService.setPinned`/`reorderTabs`) and drawn
   * as a narrow, icon-only tile. */
  pinned: boolean;
  /** Mirrors the tab's own `WebKit.WebView.is_muted`; set with `tabs:set-muted`. */
  muted: boolean;
  /** Mirrors `WebKit.WebView.is_playing_audio` -- whether to show the mute control at all (Chrome's
   * own rule: only while a tab is audible or already muted, not on every tab). */
  playingAudio: boolean;
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
  /** See `TabState.pinned`. Kept here (not derived), since only `setPinned`/`reorderTabs` may
   * change it -- unlike `muted`, which is just read straight off `view.is_muted` on every snapshot. */
  pinned: boolean;
}

/** What the tab shows while a Chromium window is embedded in it. */
export interface TabEmbed {
  handle: EmbedHandle;
  url: string;
  /** The embedded window's title once Chrome has one; empty until then. */
  title: string;
  /** "Firefox 156": which browser a test tab shows; empty for streaming pages. */
  label: string;
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
  /** Embeds a browser installed for testing pages (started from `spec`) over `view`. */
  attachBrowser: (view: WebKit.WebView, spec: EmbedSpec) => EmbedHandle | null;
  /**
   * Offered every page a tab is about to load. Returns true when another program took it (DRM
   * sites). `source` is the view that was navigating, so the page can take over that same tab.
   */
  handOff: (url: string, source?: WebKit.WebView) => boolean;
  /**
   * F12 on a built-in page (Settings, History ...): the page is drawn by the browser's own UI, so
   * that is what gets inspected. Does nothing while the Web Inspector setting is off.
   */
  toggleUiDevTools: (tabId: number) => void;
  /** True when F12 should open Chrome DevTools rather than the WebKit Web Inspector. */
  useChromeDevTools: () => boolean;
  /** Opens or closes the Chrome DevTools panel of a tab's page. */
  toggleChromeDevTools: (view: WebKit.WebView, tabId: number) => void;
  /** Called for every tab's web view, so its Web Inspector can be dressed (see InspectorFrame). */
  watchInspector: (view: WebKit.WebView) => void;
  /** Called when a tab asks for HTML fullscreen (a video), so the chrome can get out of the way. */
  setContentFullscreen: (fullscreen: boolean) => void;
}
