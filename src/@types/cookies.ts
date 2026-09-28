import type Soup from 'gi://Soup?version=3.0';

/** What a cookie is for, as far as Webswitch can tell from its name and flags. */
export type CookieKind = 'authentication' | 'security' | 'preferences' | 'analytics' | 'other';

export type CookieSameSite = 'none' | 'lax' | 'strict';

/**
 * `active`: normal. `disabled`: kept by Webswitch but not sent to any site. `only-on`: sent only
 * while a tab shows one of the listed sites.
 */
export type CookieMode = 'active' | 'disabled' | 'only-on';

export interface CookiePolicy {
  mode: CookieMode;
  /** Only for `only-on`: host names such as "youtube.com" (subdomains included). */
  sites: string[];
}

/** Which rule governs a cookie: one set on the cookie itself, or its company's rule. */
export type CookieRuleOrigin = 'cookie' | 'company';

/** A cookie Webswitch keeps a copy of while the browser is not holding it. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Milliseconds since the epoch; null for a session cookie. */
  expires: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookieSameSite;
}

/** What the UI is told about one cookie. The value itself never leaves the native side. */
export interface CookieInfo {
  /** "domain<TAB>path<TAB>name": stable across restarts. */
  id: string;
  name: string;
  domain: string;
  path: string;
  company: string;
  kind: CookieKind;
  /** What the cookie does behind the scenes, in plain words. */
  explanation: string;
  /**
   * When Webswitch first saw the cookie (WebKit does not store creation dates). Null for cookies
   * that already existed when Webswitch started tracking.
   */
  firstSeen: number | null;
  /** Null for a session cookie (gone when the browser closes). */
  expires: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookieSameSite;
  mode: CookieMode;
  sites: string[];
  /** Where the rule comes from; null when the cookie has none (it is allowed everywhere). */
  origin: CookieRuleOrigin | null;
  /** True while the cookie is really in the browser's jar (a disabled one is not). */
  inJar: boolean;
}

export interface CookieAccountPanel {
  label: string;
  url: string;
}

/** What is known about a company that sets cookies. */
export interface CookieCompanyDetails {
  name: string;
  accountPanel: CookieAccountPanel | null;
  /** Shown before removing one of its cookies. */
  removalWarning: string;
}

/** A company as the UI sees it: its details plus the rule that covers all its cookies. */
export interface CookieCompanyInfo extends CookieCompanyDetails {
  /** `active` means no company rule. Applies to the company's cookies now and in the future. */
  mode: CookieMode;
  sites: string[];
}

export interface CookiesState {
  cookies: CookieInfo[];
  companies: CookieCompanyInfo[];
}

/** The rule that covers every cookie of one company, including cookies it sets later. */
export interface CookieCompanyRule {
  mode: Exclude<CookieMode, 'active'>;
  sites: string[];
}

/** The file Webswitch keeps next to the browser's own cookie database. */
export interface CookieStoreFile {
  version: 1;
  /** Cookie id -> first time seen (ms); 0 means it existed before tracking. */
  firstSeen: Record<string, number>;
  policies: Record<string, CookieStoredPolicy>;
  /** Company name -> rule. No entry means no rule. */
  companies: Record<string, CookieCompanyRule>;
  /** Cookies the user set back to "allowed" on purpose, whatever their company's rule says. */
  exempt: Record<string, true>;
}

export interface CookieStoredPolicy {
  mode: Exclude<CookieMode, 'active'>;
  sites: string[];
  origin: CookieRuleOrigin;
  cookie: StoredCookie;
}

export interface CookieMatch {
  company: string;
  kind: CookieKind;
  explanation: string;
}

/** One company (or, for unknown sites, one registrable domain) in the cookie catalog. */
export interface CookieCompanyEntry {
  name: string;
  /** Registrable domains (or prefixes ending in a dot, for country variants: "google."). */
  domains: readonly string[];
  panel?: CookieAccountPanel;
  /** What signing out costs. Falls back to a generic sentence. */
  warning?: string;
}

export interface KnownCookie {
  kind: CookieKind;
  explanation: string;
}

/** Every cookie in the browser's jar, keyed by cookie id. */
export type CookieJar = Map<string, Soup.Cookie>;

/** The short version of the cookie state that the menu shows under "Cookies and accounts". */
export interface CookiesSummary {
  /** Companies with a sign-in cookie in the browser right now. */
  signedIn: string[];
  /** Every cookie in the browser. */
  total: number;
}
