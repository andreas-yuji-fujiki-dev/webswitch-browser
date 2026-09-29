/** A browser that can play DRM content, found on this machine. */
export interface DrmBrowser {
  /** Absolute path to the executable. */
  path: string;
  /** For messages: "Google Chrome". */
  name: string;
}

/** One Chromium window embedded in a tab (experimental, X11 only). */
export interface EmbedHandle {
  /** Called once when the embedded window goes away (closed inside Chrome, or crashed). */
  onClosed(listener: () => void): void;
  /** Called with the embedded window's title (Chrome sets it to the page title) whenever it changes. */
  onTitle(listener: (title: string) => void): void;
  /** Debugging: sends one command to the X11 helper (`geometry`, `shotparent <path>`) and returns its answer. */
  probe(line: string): Promise<string>;
  /** Gives the embedded window the keyboard focus. */
  focus(): void;
  /** Closes the embedded window and stops following the tab. */
  close(): void;
}

/** The parts of Chrome's `Preferences` file Webswitch edits; everything else is kept as it is. */
export interface ChromePreferences {
  profile?: ChromeProfilePreferences;
  [other: string]: unknown;
}

export interface ChromeProfilePreferences {
  default_content_setting_values?: ChromeContentSettings;
  [other: string]: unknown;
}

export interface ChromeContentSettings {
  notifications?: number;
  [other: string]: unknown;
}
