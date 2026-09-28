export type ThemeScheme = 'dark' | 'light';

/** The colors a theme sets. Every other color of the UI is derived from these. */
export interface ThemeColors {
  /** The window, the tab strip, the address bar and the pages of the UI. */
  bg: string;
  /** Raised surfaces (menus, panels). */
  raised: string;
  hover: string;
  border: string;
  fg: string;
  fgStrong: string;
  fgSoft: string;
  fgMuted: string;
  /** The main color: focus, the active tab, borders that matter. */
  accent: string;
  info: string;
  success: string;
  danger: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  author?: string;
  /** The license the theme comes under, when it was installed from somewhere that says. */
  license?: string;
  /** Where it came from, e.g. `openvsx:zhuangtongfa.material-theme`. */
  source?: string;
  scheme: ThemeScheme;
  colors: ThemeColors;
}

/** A theme as the Themes page sees it. */
export interface ThemeInfo extends ThemeDefinition {
  /** Ships with Webswitch: cannot be removed. */
  builtin: boolean;
}

/** Order of the search on Open VSX. */
export type VsxSort = 'relevance' | 'downloadCount' | 'averageRating' | 'timestamp';

/** One extension found on Open VSX. */
export interface VsxResult {
  /** "publisher.name". */
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  downloads: number;
  rating: number | null;
  version: string;
  /** Its themes were installed here already. */
  installed: boolean;
}

export interface VsxSearchAnswer {
  total: number;
  results: VsxResult[];
}

export type VsxInstallResult = { ok: true; added: string[] } | { ok: false; error: string };

export interface ThemesState {
  /** What the user chose: a theme id, or `system` (Webswitch's dark or light, whichever the desktop uses). */
  active: string;
  /** The theme really on screen (what `system` currently means). */
  resolved: string;
  themes: ThemeInfo[];
  /** Set while themes are being fetched in bulk: what it is doing and how far it is. */
  busy: { text: string; done: number; total: number } | null;
}

export type ThemeResult = { ok: true; id: string } | { ok: false; error: string };

/** What a theme file may contain: only `name`, `bg`, `fg` and `accent` are required. */
export interface ThemeFileInput {
  name?: unknown;
  author?: unknown;
  license?: unknown;
  source?: unknown;
  scheme?: unknown;
  colors?: Partial<Record<keyof ThemeColors, unknown>>;
}

/** `theme.json`: which theme is in use. */
export interface ThemeChoiceFile {
  version: 1;
  active?: string;
}

/** What Open VSX answers for a search (only what is used). */
export interface VsxSearchResponse {
  totalSize?: number;
  extensions?: {
    namespace?: string;
    name?: string;
    displayName?: string;
    description?: string;
    downloadCount?: number;
    averageRating?: number;
    version?: string;
  }[];
}

/** What Open VSX answers for one extension (only what is used). */
export interface VsxExtensionResponse {
  namespace?: string;
  name?: string;
  displayName?: string;
  version?: string;
  license?: string;
  files?: { download?: string; sha256?: string };
}

/** What an extension's `package.json` says about its color themes (only what is used). */
export interface VsxManifest {
  contributes?: { themes?: { label?: string; uiTheme?: string; path?: string }[] };
}
