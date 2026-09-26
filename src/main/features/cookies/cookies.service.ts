import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';
import WebKit from 'gi://WebKit?version=6.0';
import type { Unsubscribe } from '~types/common';
import type {
  CookieInfo,
  CookieJar,
  CookiePolicy,
  CookieSameSite,
  CookieStoreFile,
  CookiesState,
  StoredCookie,
} from '~types/cookies';
import { debug } from '../../core/debug';
import { readText } from '../../core/files';
import { dataDir } from '../../core/paths';
import { parseUrl } from '../../core/url';
import '../../core/webkit-async';
import { companyInfo, companyOf, describeCookie, registrableDomain } from './cookie-catalog';

const STORE_FILENAME = 'cookie-policies.json';
const SYNC_DEBOUNCE_MS = 400;
const OWNER_ONLY = 0o600;

export function cookieId(cookie: { domain: string; path: string; name: string }): string {
  return `${cookie.domain}\t${cookie.path}\t${cookie.name}`;
}

function sameSiteOf(policy: Soup.SameSitePolicy): CookieSameSite {
  if (policy === Soup.SameSitePolicy.STRICT) return 'strict';
  if (policy === Soup.SameSitePolicy.LAX) return 'lax';
  return 'none';
}

function sameSitePolicy(value: CookieSameSite): Soup.SameSitePolicy {
  if (value === 'strict') return Soup.SameSitePolicy.STRICT;
  if (value === 'lax') return Soup.SameSitePolicy.LAX;
  return Soup.SameSitePolicy.NONE;
}

function fromSoup(cookie: Soup.Cookie): StoredCookie {
  const expires = cookie.get_expires();
  return {
    name: cookie.get_name(),
    value: cookie.get_value(),
    domain: cookie.get_domain(),
    path: cookie.get_path(),
    expires: expires === null ? null : expires.to_unix() * 1000,
    secure: cookie.get_secure(),
    httpOnly: cookie.get_http_only(),
    sameSite: sameSiteOf(cookie.get_same_site_policy()),
  };
}

function toSoup(stored: StoredCookie): Soup.Cookie {
  const cookie = new Soup.Cookie(stored.name, stored.value, stored.domain, stored.path, -1);
  cookie.set_secure(stored.secure);
  cookie.set_http_only(stored.httpOnly);
  cookie.set_same_site_policy(sameSitePolicy(stored.sameSite));
  if (stored.expires !== null) {
    const expires = GLib.DateTime.new_from_unix_utc(Math.floor(stored.expires / 1000));
    if (expires !== null) cookie.set_expires(expires);
  }
  return cookie;
}

function isExpired(cookie: StoredCookie): boolean {
  return cookie.expires !== null && cookie.expires <= Date.now();
}

/** "https://www.YouTube.com/watch" or ".youtube.com" -> "www.youtube.com" / "youtube.com". */
export function normalizeSite(text: string): string | null {
  const bare = text
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^\*?\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '');
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(bare) ? bare : null;
}

/** Valid, unique site names from what the user typed. */
export function normalizeSites(sites: string[]): string[] {
  return [...new Set(sites.map(normalizeSite).filter((site): site is string => site !== null))];
}

function hostMatches(host: string, site: string): boolean {
  return host === site || host.endsWith(`.${site}`);
}

/**
 * The cookie manager. WebKit can list, add and delete cookies but has no per-site cookie rules, so
 * "disabled" and "only on these sites" are done by keeping a copy of the cookie in Webswitch's own
 * file and taking it out of (or putting it back into) the browser's jar:
 *
 * - disabled: not in the jar, ever; a site that sets it again gets it removed again.
 * - only-on: in the jar exactly while some open tab shows one of its sites.
 *
 * WebKit does not store creation dates either, so "first seen" is recorded here from the moment
 * Webswitch starts tracking (cookies that already existed have no date).
 */
export class CookiesService {
  private store: CookieStoreFile = {
    version: 1,
    firstSeen: {},
    policies: {},
    companies: {},
    exempt: {},
  };
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private syncTimer = 0;
  private initialized = false;

  constructor(
    private readonly session: WebKit.NetworkSession,
    /** Hosts of the pages the open tabs are on (or heading to). */
    private readonly openHosts: () => string[],
  ) {}

  /** WebKit's own cookie database (see bootstrap.ts, where it is chosen). */
  private databasePath(): string {
    return GLib.build_filenamev([dataDir(), 'cookies.sqlite']);
  }

  private filePath(): string {
    return GLib.build_filenamev([dataDir(), STORE_FILENAME]);
  }

  async init(): Promise<void> {
    const text = await readText(this.filePath());
    if (text !== null) {
      try {
        const parsed = JSON.parse(text) as Partial<CookieStoreFile>;
        if (parsed.version === 1) {
          this.store = {
            version: 1,
            firstSeen: parsed.firstSeen ?? {},
            policies: parsed.policies ?? {},
            companies: parsed.companies ?? {},
            exempt: parsed.exempt ?? {},
          };
        }
      } catch {
        debug('cookies', 'the policy file is unreadable; starting empty');
      }
    }
    this.session.get_cookie_manager().connect('changed', () => {
      if (this.initialized) this.scheduleSync();
    });
    // Everything already in the jar at this point has no known creation time (0).
    await this.enqueue(async () => {
      const jar = await this.readCookieJar();
      if (jar) {
        for (const id of jar.keys()) this.store.firstSeen[id] ??= 0;
        this.applyCompanyRules(jar);
        await this.applyPolicies(jar);
        this.save();
      }
    });
    this.initialized = true;
  }

  onChanged(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getState(): Promise<CookiesState> {
    const jar = (await this.enqueue(() => this.readCookieJar())) ?? new Map<string, Soup.Cookie>();
    const cookies: CookieInfo[] = [];
    for (const [id, soup] of jar) cookies.push(this.describe(id, fromSoup(soup), true));
    for (const [id, policy] of Object.entries(this.store.policies)) {
      if (!jar.has(id)) cookies.push(this.describe(id, policy.cookie, false));
    }
    cookies.sort(
      (a, b) =>
        a.company.localeCompare(b.company) ||
        a.domain.localeCompare(b.domain) ||
        a.name.localeCompare(b.name),
    );
    const names = [...new Set(cookies.map((cookie) => cookie.company))];
    const companies = names.map((name) => ({
      ...companyInfo(name),
      mode: this.store.companies[name]?.mode ?? ('active' as const),
      sites: this.store.companies[name]?.sites ?? [],
    }));
    return { cookies, companies };
  }

  /** Deletes cookies from the browser and forgets Webswitch's copies. */
  async remove(ids: string[]): Promise<void> {
    await this.enqueue(async () => {
      const jar = (await this.readCookieJar()) ?? new Map<string, Soup.Cookie>();
      for (const id of ids) {
        const soup = jar.get(id);
        if (soup) await this.session.get_cookie_manager().delete_cookie(soup, null);
        Reflect.deleteProperty(this.store.policies, id);
        Reflect.deleteProperty(this.store.firstSeen, id);
        Reflect.deleteProperty(this.store.exempt, id);
      }
      this.save();
    });
    this.notify();
  }

  /** A rule for single cookies. It overrides the rule of their company, if there is one. */
  async setPolicy(ids: string[], policy: CookiePolicy): Promise<void> {
    await this.enqueue(async () => {
      const jar = (await this.readCookieJar()) ?? new Map<string, Soup.Cookie>();
      for (const id of ids) {
        const existing = this.store.policies[id];
        const soup = jar.get(id);
        const cookie = soup ? fromSoup(soup) : existing?.cookie;
        if (!cookie) continue;

        if (policy.mode === 'active') {
          if (existing && !soup && !isExpired(existing.cookie)) {
            await this.session.get_cookie_manager().add_cookie(toSoup(existing.cookie), null);
          }
          Reflect.deleteProperty(this.store.policies, id);
          // Allowed on purpose: the company's rule must not take it back.
          if (this.store.companies[companyOf(cookie.domain)]) this.store.exempt[id] = true;
          continue;
        }
        Reflect.deleteProperty(this.store.exempt, id);
        const sites = policy.mode === 'only-on' ? normalizeSites(policy.sites) : [];
        // With no valid site given, the cookie's own site is the safe choice.
        if (policy.mode === 'only-on' && sites.length === 0) {
          sites.push(registrableDomain(cookie.domain));
        }
        this.store.policies[id] = { mode: policy.mode, sites, origin: 'cookie', cookie };
      }
      // Apply now, against the jar as it will look after the changes above.
      const fresh = (await this.readCookieJar()) ?? new Map<string, Soup.Cookie>();
      await this.applyPolicies(fresh);
      this.save();
    });
    this.notify();
  }

  /**
   * One rule for every cookie of `company`, the ones it has now and the ones it sets later
   * (`active` removes the rule). Cookies with a rule of their own keep it.
   */
  async setCompanyPolicy(company: string, policy: CookiePolicy): Promise<void> {
    await this.enqueue(async () => {
      const sites = policy.mode === 'only-on' ? normalizeSites(policy.sites) : [];
      // "Only on" with no valid site would silently mean "never": ask again instead.
      if (policy.mode === 'only-on' && sites.length === 0) return;

      const jar = (await this.readCookieJar()) ?? new Map<string, Soup.Cookie>();
      if (policy.mode === 'active') {
        Reflect.deleteProperty(this.store.companies, company);
      } else {
        this.store.companies[company] = { mode: policy.mode, sites };
      }

      // Cookies already under this company's rule follow the change (or are released).
      for (const [id, existing] of Object.entries(this.store.policies)) {
        if (existing.origin !== 'company' || companyOf(existing.cookie.domain) !== company)
          continue;
        if (policy.mode === 'active') {
          if (!jar.has(id) && !isExpired(existing.cookie)) {
            await this.session.get_cookie_manager().add_cookie(toSoup(existing.cookie), null);
          }
          Reflect.deleteProperty(this.store.policies, id);
        } else {
          existing.mode = policy.mode;
          existing.sites = [...sites];
        }
      }
      if (policy.mode === 'active') {
        // A cookie allowed on purpose only mattered while there was a company rule.
        for (const id of Object.keys(this.store.exempt)) {
          if (companyOf(id.split('\t')[0] ?? '') === company) {
            Reflect.deleteProperty(this.store.exempt, id);
          }
        }
      }

      const fresh = (await this.readCookieJar()) ?? new Map<string, Soup.Cookie>();
      this.applyCompanyRules(fresh);
      await this.applyPolicies(fresh);
      this.save();
    });
    this.notify();
  }

  /** True when loading `url` must first put back a cookie that is only allowed on that site. */
  needsPrepare(url: string): boolean {
    const host = parseUrl(url)?.host;
    if (!host) return false;
    return Object.values(this.store.policies).some(
      (policy) =>
        policy.mode === 'only-on' &&
        !isExpired(policy.cookie) &&
        policy.sites.some((site) => hostMatches(host, site)),
    );
  }

  /** Puts the restricted cookies for `url`'s site into the jar, before the page is requested. */
  async prepare(url: string): Promise<void> {
    const host = parseUrl(url)?.host;
    if (!host) return;
    await this.enqueue(async () => {
      const jar = (await this.readCookieJar()) ?? new Map<string, Soup.Cookie>();
      for (const [id, policy] of Object.entries(this.store.policies)) {
        if (policy.mode !== 'only-on' || jar.has(id) || isExpired(policy.cookie)) continue;
        if (!policy.sites.some((site) => hostMatches(host, site))) continue;
        await this.session.get_cookie_manager().add_cookie(toSoup(policy.cookie), null);
        debug('cookies', `restored ${policy.cookie.name} for ${host}`);
      }
    });
  }

  /** Re-evaluates the policies soon: tabs moved, or a site changed its cookies. */
  scheduleSync(): void {
    if (this.syncTimer !== 0) return;
    this.syncTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYNC_DEBOUNCE_MS, () => {
      this.syncTimer = 0;
      void this.enqueue(() => this.sync()).then(() => {
        this.notify();
      });
      return GLib.SOURCE_REMOVE;
    });
  }

  private async sync(): Promise<void> {
    const jar = await this.readCookieJar();
    if (!jar) return;
    const now = Date.now();
    for (const id of jar.keys()) this.store.firstSeen[id] ??= now;
    for (const id of Object.keys(this.store.firstSeen)) {
      if (!jar.has(id) && !(id in this.store.policies))
        Reflect.deleteProperty(this.store.firstSeen, id);
    }
    this.applyCompanyRules(jar);
    await this.applyPolicies(jar);
    this.save();
  }

  /** A cookie without a rule of its own gets its company's rule, so new cookies are covered too. */
  private applyCompanyRules(jar: CookieJar): void {
    for (const [id, soup] of jar) {
      if (id in this.store.policies || id in this.store.exempt) continue;
      const cookie = fromSoup(soup);
      const rule = this.store.companies[companyOf(cookie.domain)];
      if (rule) {
        this.store.policies[id] = {
          mode: rule.mode,
          sites: [...rule.sites],
          origin: 'company',
          cookie,
        };
      }
    }
  }

  /** Makes the jar match the policies. `jar` is updated to reflect what was done. */
  private async applyPolicies(jar: CookieJar): Promise<void> {
    const manager = this.session.get_cookie_manager();
    const hosts = this.openHosts();
    for (const [id, policy] of Object.entries(this.store.policies)) {
      const soup = jar.get(id);
      const allowedNow =
        policy.mode === 'only-on' &&
        policy.sites.some((site) => hosts.some((host) => hostMatches(host, site)));
      if (allowedNow) {
        if (!soup && !isExpired(policy.cookie)) {
          await manager.add_cookie(toSoup(policy.cookie), null);
        }
      } else if (soup) {
        // Keep the newest value the site gave it before taking it out.
        policy.cookie = fromSoup(soup);
        await manager.delete_cookie(soup, null);
        jar.delete(id);
      }
    }
  }

  /**
   * Every cookie in the jar, keyed by id; null when it could not be read.
   *
   * WebKit's data manager lists cookies by registrable domain ("example.org"), and asking for that
   * address does not return a cookie that belongs only to a subdomain ("moodle.example.org"), which is
   * how many sign-in cookies are set. So the complete list comes from WebKit's own cookie database
   * (read with libsoup's jar, no SQLite needed), and what WebKit says live is laid over it.
   */
  private async readCookieJar(): Promise<CookieJar | null> {
    const jar: CookieJar = new Map();
    const remember = (soup: Soup.Cookie): void => {
      jar.set(
        cookieId({ domain: soup.get_domain(), path: soup.get_path(), name: soup.get_name() }),
        soup,
      );
    };
    let read = false;
    try {
      // Read-only: WebKit owns the file, and its writes reach it as they happen.
      const database = Soup.CookieJarDB.new(this.databasePath(), true);
      for (const soup of database.all_cookies()) remember(soup);
      read = true;
    } catch (error) {
      debug('cookies', `could not read the cookie database: ${String(error)}`);
    }
    try {
      const manager = this.session.get_cookie_manager();
      const data = await this.session
        .get_website_data_manager()
        .fetch(WebKit.WebsiteDataTypes.COOKIES, null);
      const lists = await Promise.all(
        data.map((entry) =>
          manager.get_cookies(`https://${entry.get_name().replace(/^\./, '')}/`, null),
        ),
      );
      for (const list of lists) for (const soup of list) remember(soup);
      read = true;
    } catch (error) {
      debug('cookies', `could not read the live cookies: ${String(error)}`);
    }
    return read ? jar : null;
  }

  private describe(id: string, cookie: StoredCookie, inJar: boolean): CookieInfo {
    const policy = this.store.policies[id];
    const match = describeCookie(cookie.name, cookie.domain, {
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      session: cookie.expires === null,
    });
    const seen = this.store.firstSeen[id];
    return {
      id,
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      company: match.company,
      kind: match.kind,
      explanation: match.explanation,
      firstSeen: seen !== undefined && seen > 0 ? seen : null,
      expires: cookie.expires,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      mode: policy?.mode ?? 'active',
      sites: policy?.sites ?? [],
      origin: policy?.origin ?? null,
      inJar,
    };
  }

  /** The file holds cookie values (they are already in the browser's own database): owner only. */
  private save(): void {
    try {
      GLib.file_set_contents_full(
        this.filePath(),
        new TextEncoder().encode(JSON.stringify(this.store)),
        GLib.FileSetContentsFlags.CONSISTENT,
        OWNER_ONLY,
      );
    } catch (error) {
      debug('cookies', `could not save the policy file: ${String(error)}`);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Cookie operations run one at a time, so a slow read never overlaps a change. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
