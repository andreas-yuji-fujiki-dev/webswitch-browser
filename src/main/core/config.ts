import type { SearchEngine } from '~types/navigation';

export const APP_ID = 'dev.webswitch.Webswitch';
export const APP_NAME = 'Webswitch';

/** The one place to change the search engine. Making it user-configurable is on the to-do list. */
export const DEFAULT_SEARCH_ENGINE: SearchEngine = {
  name: 'DuckDuckGo',
  urlTemplate: 'https://duckduckgo.com/?q=%s',
};

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

// Kept next to `user.css` and `keybindings.json` in ~/.config/webswitch.
export const KEYBINDINGS_FILENAME = 'keybindings.json';
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
