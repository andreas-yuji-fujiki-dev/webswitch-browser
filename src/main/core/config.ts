import type { SearchEngine } from '~types/navigation';
import type { SettingsValues } from '~types/settings';

export const APP_ID = 'dev.webswitch.Webswitch';
export const APP_NAME = 'Webswitch';

/** The engines the Settings page offers, by the value the `searchEngine` setting stores. */
const SEARCH_ENGINES: Record<SettingsValues['searchEngine'], SearchEngine> = {
  duckduckgo: { name: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q=%s' },
  brave: { name: 'Brave Search', urlTemplate: 'https://search.brave.com/search?q=%s' },
  startpage: { name: 'Startpage', urlTemplate: 'https://www.startpage.com/do/search?q=%s' },
  ecosia: { name: 'Ecosia', urlTemplate: 'https://www.ecosia.org/search?q=%s' },
  google: { name: 'Google', urlTemplate: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', urlTemplate: 'https://www.bing.com/search?q=%s' },
};

export function searchEngineFor(id: SettingsValues['searchEngine']): SearchEngine {
  return SEARCH_ENGINES[id];
}

export const WINDOW = {
  width: 1280,
  height: 800,
  minWidth: 480,
  minHeight: 320,
} as const;

// Used until the UI reports its real height. Mirrors the default tab strip + toolbar in tokens.css.
export const FALLBACK_CHROME_HEIGHT = 112;

// The UI is a set of static files served to its web view through this scheme (see ui-scheme.ts).
export const UI_SCHEME = 'webswitch';
export const UI_HOST = 'ui';
// The Chrome DevTools frontend is served through its own scheme (see devtools-scheme.ts).
export const DEVTOOLS_SCHEME = 'webswitch-devtools';
/** An installed extension's files, at `webswitch-ext://<id>/` (only while extensions are allowed). */
export const EXTENSION_SCHEME = 'webswitch-ext';

// Kept next to `user.css` and `keybindings.json` in ~/.config/webswitch.
export const KEYBINDINGS_FILENAME = 'keybindings.json';
export const SETTINGS_FILENAME = 'settings.json';
export const USER_CSS_FILENAME = 'user.css';
export const USER_CSS_DEBOUNCE_MS = 100;

// Kept in ~/.local/share/webswitch.
export const HISTORY_FILENAME = 'history.jsonl';
export const HISTORY_MAX_ENTRIES = 20000;
export const HISTORY_QUERY_MAX = 500;
// Reloading a page right away must not add a second entry.
export const HISTORY_DEDUPE_MS = 10_000;

// Signing in is just visiting Google's own page. The browser makes no request until the user clicks.
export const GOOGLE_SIGN_IN_URL =
  'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmyaccount.google.com%2F';
export const GOOGLE_ACCOUNT_URL = 'https://myaccount.google.com/';

// The line along a docked Web Inspector's edge, in the theme's main color.
export const INSPECTOR_EDGE_PX = 2;

// The Chrome DevTools panel under the page: its default share of the page area, and the least the
// panel and the page keep.
export const DEVTOOLS_PANEL = {
  defaultFraction: 0.4,
  minPanelHeight: 120,
  minPageHeight: 120,
  splitterHeight: 8,
} as const;

// The menu panel: how much of the window it takes by default, and the least it and the page keep.
export const MENU_PANEL = {
  defaultFraction: 0.5,
  minPanelWidth: 240,
  minPageWidth: 240,
  splitterWidth: 8,
} as const;
