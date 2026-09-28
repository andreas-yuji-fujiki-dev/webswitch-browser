import type { BROWSERS } from '~shared/browsers-catalog';

export interface BrowserDefinition {
  id: string;
  name: string;
  engine: 'Blink' | 'Gecko' | 'WebKit';
  /** `main`: one of the three engines. `extra`: same engine as another one, other defaults. */
  tier: 'main' | 'extra';
  source: 'download' | 'builtin';
  description: string;
}

export type BrowserId = (typeof BROWSERS)[number]['id'];

/** One release of a browser that is on this machine. */
export interface InstalledBrowser {
  version: string;
  /** Bytes on disk (the whole install folder). */
  sizeBytes: number;
  /** The release "Open this page in ..." uses. */
  active: boolean;
}

export type BrowserPhase = 'listing' | 'downloading' | 'verifying' | 'unpacking' | 'removing';

export interface BrowserStatus {
  id: BrowserId;
  installed: InstalledBrowser[];
  /** Releases that can be installed, newest first (empty until a check). */
  versions: string[];
  /** The newest release known (after a check). */
  latest: string | null;
  /** The newest release is newer than the one in use. */
  updateAvailable: boolean;
  busy: { phase: BrowserPhase; version: string | null; percent: number | null } | null;
  /** Why the last install or check failed. */
  error: string | null;
  /** Some releases cannot be checked against a published checksum; the answer of the last install. */
  verified: boolean | null;
}

export interface BrowsersState {
  browsers: BrowserStatus[];
  /** Everything the installed browsers take on disk. */
  totalBytes: number;
  /** Which browser plays Netflix, Spotify and the like: `system` (a Chrome found on this machine) or one of ours. */
  streaming: string;
  /** Whether the system has a Chromium-family browser that can be used for streaming. */
  systemStreamingBrowser: string | null;
  /**
   * Whether a tab can show these browsers: `ready`; `restart` when Webswitch has to be started again
   * to run on X11; `off` when the General settings switch for it is off.
   */
  embedding: 'ready' | 'restart' | 'off';
  /** A browser the page should scroll to and mark (its icon in the menu was clicked): `n` counts the requests, `at` is when (ms since the epoch): an old one is ignored. */
  focus: { id: BrowserId; n: number; at: number } | null;
}

export type BrowserResult = { ok: true } | { ok: false; error: string };

/** `browsers.json`: which release of each browser is in use, and which one plays streaming sites. */
export interface BrowsersFile {
  version: 1;
  active?: Partial<Record<string, string>>;
  streaming?: string;
}

/** How to start a browser inside a tab: what to run, and how to find its window. */
export interface EmbedSpec {
  argv: string[];
  /** Extra environment (`KEY=value`) on top of the browser's own. */
  env?: string[];
  /** The process that owns the window: how it is found after start (default: the process started). */
  pid?: (started: number) => number | null;
  /** Name for the tab, e.g. "Firefox 156". */
  label?: string;
  /** The browser was started for this tab alone: stop it when the tab closes. */
  killOnClose?: boolean;
  /** Called once when the window is gone (delete a throwaway profile). */
  cleanup?: () => void;
}

/** What to fetch and how to unpack it, for one release of one browser. */
export interface InstallPlan {
  version: string;
  url: string;
  kind: 'zip' | 'tar' | 'deb';
  /** The SHA-256 the vendor publishes for the file, or null when it publishes none for this release. */
  sha256: string | null;
}

export interface VersionListing {
  /** Releases that can be installed, newest first. */
  versions: string[];
  latest: string;
}

/** A release in Chrome for Testing's list (only what is used). */
export interface CftVersion {
  version: string;
  downloads?: { chrome?: { platform: string; url: string }[] };
}

/** The browsers that are downloaded and installed here (every one but WebKit, which is the engine Webswitch runs). */
export type InstallableBrowser = Exclude<BrowserId, 'webkit'>;
