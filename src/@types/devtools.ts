import type WebKit from 'gi://WebKit?version=6.0';
import type { DEVTOOLS_PROVIDERS } from '~shared/devtools-catalog';

/** A rectangle in the main window's overlay, in pixels. */
export interface EdgeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DevToolsProviderDefinition {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'download';
}

export type DevToolsProviderId = (typeof DEVTOOLS_PROVIDERS)[number]['id'];

export interface DevToolsProviderStatus {
  id: DevToolsProviderId;
  installed: boolean;
  /** Disk space the files take, when installed and not built in. */
  sizeBytes: number | null;
  busy: 'downloading' | 'removing' | null;
  /** 0..100 while downloading. */
  percent: number | null;
  /** Why the last download failed. */
  error: string | null;
  /** Where the files are: inside the app folder (the copy that comes with Webswitch) or downloaded. */
  location: 'app' | 'downloaded' | null;
  /** The release the files are. */
  version: string | null;
  /** A newer release than `version` is known (after a check) and can be installed. */
  updateAvailable: boolean;
}

export interface DevToolsState {
  /** The one F12 opens. */
  active: DevToolsProviderId;
  providers: DevToolsProviderStatus[];
  /** What the last look at the registry found; nothing is asked until the user presses Check. */
  registry: {
    checking: boolean;
    /** Releases that can be installed, newest first (empty until a check). */
    versions: string[];
    latest: string | null;
    error: string | null;
  };
}

export type DevToolsResult = { ok: true } | { ok: false; error: string };

/** `devtools.json`: which developer tools F12 opens. */
export interface DevToolsFile {
  version: 1;
  active?: string;
  /** The copy that comes with the app was uninstalled: it stays on disk but is not offered. */
  seedRemoved?: boolean;
}

/** One open Chrome DevTools panel: the inspected tab's view and the view that shows DevTools. */
export interface DevToolsSession {
  host: WebKit.WebView;
  frontend: WebKit.WebView;
  /** The page navigated since the frontend last connected: the frontend must start over. */
  committed: boolean;
  /** Messages that went each way, for the self-test and for debugging. */
  fromPage: number;
  toPage: number;
  /** The tab the tools were opened from. */
  tabId: number;
  /** The page side listens. What the frontend sent before that waits in `queued`. */
  pageReady: boolean;
  queued: string[];
}

/** What the npm registry answers for a package version (only what is used). */
export interface RegistryAnswer {
  version?: string;
  dist?: { tarball?: string; integrity?: string };
}

/** The registry's short listing of a package: its releases and which one is the latest. */
export interface RegistryListing {
  'dist-tags'?: { latest?: string };
  versions?: Record<string, unknown>;
}
