import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Soup from 'gi://Soup?version=3.0';
import WebKit from 'gi://WebKit?version=6.0';
import { hostsOf } from '~shared/extension-manifest';
import { matchesAny, reachesEverySite } from '~shared/match-pattern';
import type { HistoryService } from '../history/history.service';
import type { ExtensionsService } from './extensions.service';
import type {
  DownloadItem,
  ExtensionCall,
  ExtensionHost,
  ExtrasAnswer,
  ExtrasContext,
  LoadedExtension,
} from '~types/extensions';
import '../../core/webkit-async';

Gio._promisify(WebKit.WebsiteDataManager.prototype, 'clear', 'clear_finish');

const MAX_HISTORY_RESULTS = 1000;
const SAME_SITE = {
  [Soup.SameSitePolicy.NONE]: 'no_restriction',
  [Soup.SameSitePolicy.LAX]: 'lax',
  [Soup.SameSitePolicy.STRICT]: 'strict',
} as const;
// Chrome names keys in a shortcut differently from Webswitch's accelerators.
const KEY_ALIASES: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Space: 'Space',
  Ctrl: 'Ctrl',
  MacCtrl: '',
  Command: '',
};

/** A shortcut written like Chrome's ("Ctrl+Shift+L") as Webswitch spells it; null if it cannot be one. */
export function toAcceleratorText(shortcut: string): string | null {
  const parts = shortcut.split('+').map((part) => part.trim());
  const out: string[] = [];
  for (const part of parts) {
    const mapped = part in KEY_ALIASES ? KEY_ALIASES[part] : part;
    if (mapped === '' || mapped === undefined) return null;
    out.push(mapped.length === 1 ? mapped.toUpperCase() : mapped);
  }
  return out.length > 0 ? out.join('+') : null;
}

/** The shortcut an extension's command asks for on Linux, in Webswitch's spelling. */
export function commandShortcut(
  command: { suggested_key?: Record<string, string> | string } | undefined,
): string | null {
  const keys = command?.suggested_key;
  if (keys === undefined) return null;
  const text = typeof keys === 'string' ? keys : (keys.linux ?? keys.default);
  return text === undefined ? null : toAcceleratorText(text);
}

const done = (value: unknown): ExtrasAnswer => ({ handled: true, value });

/**
 * The parts of the `chrome.*` API that need the browser but no web view: cookies, notifications,
 * history, downloads, management, windows, permissions and the extension's toolbar button. Every
 * call is checked against what the manifest asked for before it does anything.
 */
export class ExtensionExtras {
  private downloadCount = 0;
  private readonly downloadList = new Map<
    number,
    { item: DownloadItem; download: WebKit.Download }
  >();
  private readonly downloadIds = new WeakMap<WebKit.Download, number>();
  private readonly keepAwake = new Map<string, number>();
  private readonly subscribers = new Map<string, Set<string>>();
  private cookieWatch: Map<string, { json: string; cookie: Soup.Cookie }> | null = null;
  private cookieTimer = 0;
  private historyWatching = false;
  private lastVisit = Date.now();

  constructor(
    private readonly service: ExtensionsService,
    private readonly host: ExtensionHost,
    private readonly cookieManager: WebKit.CookieManager,
    private readonly allCookies: () => Promise<Soup.Cookie[]>,
    private readonly history: HistoryService,
    private readonly session: WebKit.NetworkSession,
    private readonly app: Gtk.Application,
    private readonly context: ExtrasContext,
  ) {
    const clicked = new Gio.SimpleAction({
      name: 'wsext-notify',
      parameter_type: GLib.VariantType.new('s'),
    });
    clicked.connect('activate', (_action, parameter) => {
      if (!parameter) return;
      const [extension, id] = JSON.parse(parameter.get_string()[0]) as [string, string];
      this.context.fire(extension, 'notifications.onClicked', [id]);
    });
    app.add_action(clicked);
    // Every download the browser makes is listed, so extensions can see and follow them.
    session.connect('download-started', (_session, download) => {
      // Nothing is followed unless an extension that may see downloads is on.
      if (this.service.active().some((extension) => this.has(extension, 'downloads'))) {
        this.track(download, undefined);
      }
    });
  }

  /** An extension listens to an event that needs watching (cookies changing, pages visited). */
  subscribe(extension: string, name: string): void {
    const set = this.subscribers.get(name) ?? new Set<string>();
    set.add(extension);
    this.subscribers.set(name, set);
    if (name === 'cookies.onChanged' && this.cookieWatch === null) {
      this.cookieWatch = new Map();
      void this.snapshot().then((first) => {
        this.cookieWatch = first;
      });
      this.cookieManager.connect('changed', () => {
        if (this.cookieTimer !== 0) return;
        this.cookieTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
          this.cookieTimer = 0;
          void this.compareCookies();
          return GLib.SOURCE_REMOVE;
        });
      });
    }
    if (name === 'history.onVisited' && !this.historyWatching) {
      this.historyWatching = true;
      this.history.onChanged(() => {
        const newest = this.history.query('', 1)[0];
        if (!newest || newest.visitedAt <= this.lastVisit) return;
        this.lastVisit = newest.visitedAt;
        for (const id of this.subscribers.get('history.onVisited') ?? []) {
          const extension = this.service.get(id);
          if (
            extension &&
            this.service.active().includes(extension) &&
            this.has(extension, 'history')
          ) {
            this.context.fire(id, 'history.onVisited', [
              {
                id: String(newest.visitedAt),
                url: newest.url,
                title: newest.title,
                lastVisitTime: newest.visitedAt,
                visitCount: 1,
                typedCount: 0,
              },
            ]);
          }
        }
      });
    }
  }

  private async snapshot(): Promise<Map<string, { json: string; cookie: Soup.Cookie }>> {
    const map = new Map<string, { json: string; cookie: Soup.Cookie }>();
    for (const cookie of await this.allCookies()) {
      map.set(`${cookie.get_domain()}\t${cookie.get_path()}\t${cookie.get_name()}`, {
        json: JSON.stringify(this.toChrome(cookie)),
        cookie,
      });
    }
    return map;
  }

  /** What changed in the cookie jar since the last look, told to the extensions that ask for it. */
  private async compareCookies(): Promise<void> {
    const before = this.cookieWatch ?? new Map<string, { json: string; cookie: Soup.Cookie }>();
    const after = await this.snapshot();
    this.cookieWatch = after;
    const tell = (cookie: Soup.Cookie, removed: boolean, cause: string): void => {
      for (const id of this.subscribers.get('cookies.onChanged') ?? []) {
        const extension = this.service.get(id);
        if (!extension || !this.service.active().includes(extension)) continue;
        if (!this.has(extension, 'cookies') || !this.mayReadCookie(extension, cookie)) continue;
        this.context.fire(id, 'cookies.onChanged', [
          { removed, cookie: this.toChrome(cookie), cause },
        ]);
      }
    };
    for (const [key, old] of before) {
      const now = after.get(key);
      if (!now) tell(old.cookie, true, 'explicit');
      else if (now.json !== old.json) tell(old.cookie, true, 'overwrite');
    }
    for (const [key, now] of after) {
      const old = before.get(key);
      if (old?.json !== now.json) tell(now.cookie, false, 'explicit');
    }
  }

  async handle(extension: LoadedExtension, call: ExtensionCall): Promise<ExtrasAnswer> {
    const [area = ''] = call.op.split('.');
    switch (area) {
      case 'cookies':
        return await this.cookies(extension, call);
      case 'notifications':
        return this.notifications(extension, call);
      case 'history':
        return this.historyCall(extension, call);
      case 'downloads':
        return this.downloads(extension, call);
      case 'management':
        return this.management(extension, call);
      case 'windows':
        return this.windows(call);
      case 'permissions':
        return await this.permissions(extension, call);
      case 'commands':
        return this.commands(extension);
      case 'action':
        return this.action(extension, call);
      case 'browsingData':
        return await this.browsingData(extension, call);
      case 'sessions':
        return this.sessions(call);
      case 'power':
        return this.power(extension, call);
      case 'search':
        return this.search(extension, call);
      default:
        return { handled: false };
    }
  }

  private has(extension: LoadedExtension, permission: string): boolean {
    return (extension.manifest.permissions ?? []).includes(permission);
  }

  private require(extension: LoadedExtension, permission: string): void {
    if (!this.has(extension, permission)) {
      throw new Error(`The extension did not ask for the '${permission}' permission.`);
    }
  }

  // ── cookies ────────────────────────────────────────────────────────────────────────────────
  private toChrome(cookie: Soup.Cookie): Record<string, unknown> {
    const expires = cookie.get_expires();
    const domain = cookie.get_domain();
    return {
      name: cookie.get_name(),
      value: cookie.get_value(),
      domain,
      hostOnly: !domain.startsWith('.'),
      path: cookie.get_path(),
      secure: cookie.get_secure(),
      httpOnly: cookie.get_http_only(),
      sameSite: SAME_SITE[cookie.get_same_site_policy()] ?? 'unspecified',
      session: expires === null,
      ...(expires === null ? {} : { expirationDate: expires.to_unix() }),
      storeId: '0',
    };
  }

  private mayReadCookie(extension: LoadedExtension, cookie: Soup.Cookie): boolean {
    const host = cookie.get_domain().replace(/^\./, '');
    return matchesAny(hostsOf(extension.manifest), `https://${host}/`);
  }

  private async cookies(extension: LoadedExtension, call: ExtensionCall): Promise<ExtrasAnswer> {
    this.require(extension, 'cookies');
    const details = (call.details ?? {}) as Record<string, unknown>;
    const url = typeof details.url === 'string' ? details.url : null;
    const name = typeof details.name === 'string' ? details.name : null;
    switch (call.op) {
      case 'cookies.get':
      case 'cookies.getAll': {
        if (url !== null && !matchesAny(hostsOf(extension.manifest), url)) {
          throw new Error('The extension has no permission for that address.');
        }
        let list =
          url === null ? await this.allCookies() : await this.cookieManager.get_cookies(url, null);
        list = list.filter((cookie) => this.mayReadCookie(extension, cookie));
        if (name !== null) list = list.filter((cookie) => cookie.get_name() === name);
        if (typeof details.domain === 'string') {
          const wanted = details.domain.replace(/^\./, '');
          list = list.filter((cookie) => {
            const domain = cookie.get_domain().replace(/^\./, '');
            return domain === wanted || domain.endsWith(`.${wanted}`);
          });
        }
        if (typeof details.path === 'string') {
          list = list.filter((cookie) => cookie.get_path() === details.path);
        }
        if (typeof details.secure === 'boolean') {
          list = list.filter((cookie) => cookie.get_secure() === details.secure);
        }
        if (typeof details.session === 'boolean') {
          list = list.filter((cookie) => (cookie.get_expires() === null) === details.session);
        }
        if (call.op === 'cookies.getAll') return done(list.map((cookie) => this.toChrome(cookie)));
        const best = list.sort((a, b) => b.get_path().length - a.get_path().length)[0];
        return done(best ? this.toChrome(best) : null);
      }
      case 'cookies.set': {
        if (url === null || !matchesAny(hostsOf(extension.manifest), url)) {
          throw new Error('The extension has no permission for that address.');
        }
        const parsed = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        const domain =
          typeof details.domain === 'string' ? details.domain : (parsed.get_host() ?? '');
        const path = typeof details.path === 'string' ? details.path : '/';
        const expiry = typeof details.expirationDate === 'number' ? details.expirationDate : null;
        const maxAge = expiry === null ? -1 : Math.max(0, Math.round(expiry - Date.now() / 1000));
        const cookie = new Soup.Cookie(
          name ?? '',
          typeof details.value === 'string' ? details.value : '',
          domain,
          path,
          maxAge,
        );
        cookie.set_secure(details.secure === true);
        cookie.set_http_only(details.httpOnly === true);
        const policy = {
          no_restriction: Soup.SameSitePolicy.NONE,
          strict: Soup.SameSitePolicy.STRICT,
        }[String(details.sameSite)];
        cookie.set_same_site_policy(policy ?? Soup.SameSitePolicy.LAX);
        await this.cookieManager.add_cookie(cookie, null);
        return done(this.toChrome(cookie));
      }
      case 'cookies.remove': {
        if (url === null || name === null || !matchesAny(hostsOf(extension.manifest), url)) {
          throw new Error('The extension has no permission for that address.');
        }
        const found = (await this.cookieManager.get_cookies(url, null)).find(
          (cookie) => cookie.get_name() === name,
        );
        if (found) await this.cookieManager.delete_cookie(found, null);
        return done(found ? { url, name, storeId: '0' } : null);
      }
      default:
        return { handled: false };
    }
  }

  // ── notifications ──────────────────────────────────────────────────────────────────────────
  private notifications(extension: LoadedExtension, call: ExtensionCall): ExtrasAnswer {
    this.require(extension, 'notifications');
    const { id } = extension.summary;
    const key = (name: string): string => `${id}:${name}`;
    if (call.op === 'notifications.create') {
      const options = (call.options ?? {}) as { title?: string; message?: string };
      const name =
        typeof call.id === 'string' && call.id !== '' ? call.id : `n${++this.downloadCount}`;
      const notification = new Gio.Notification();
      notification.set_title(options.title ?? extension.summary.name);
      notification.set_body(options.message ?? '');
      (
        notification as Gio.Notification & {
          set_default_action_and_target_value: (action: string, target: GLib.Variant) => void;
        }
      ).set_default_action_and_target_value(
        'app.wsext-notify',
        GLib.Variant.new_string(JSON.stringify([id, name])),
      );
      this.app.send_notification(key(name), notification);
      return done(name);
    }
    if (call.op === 'notifications.clear') {
      this.app.withdraw_notification(key(String(call.id)));
      return done(true);
    }
    return done({});
  }

  // ── history ────────────────────────────────────────────────────────────────────────────────
  private historyCall(extension: LoadedExtension, call: ExtensionCall): ExtrasAnswer {
    this.require(extension, 'history');
    const toItem = (entry: { url: string; title: string; visitedAt: number }): unknown => ({
      id: String(entry.visitedAt),
      url: entry.url,
      title: entry.title,
      lastVisitTime: entry.visitedAt,
      visitCount: 1,
      typedCount: 0,
    });
    if (call.op === 'history.search') {
      const query = (call.query ?? {}) as {
        text?: string;
        maxResults?: number;
        startTime?: number;
        endTime?: number;
      };
      const found = this.history.query(query.text ?? '', query.maxResults ?? 100);
      return done(
        found
          .filter(
            (entry) =>
              entry.visitedAt >= (query.startTime ?? 0) &&
              entry.visitedAt <= (query.endTime ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(0, MAX_HISTORY_RESULTS)
          .map(toItem),
      );
    }
    if (call.op === 'history.getVisits') {
      const { url } = (call.details ?? {}) as { url?: string };
      return done(
        this.history
          .query(url ?? '', MAX_HISTORY_RESULTS)
          .filter((entry) => entry.url === url)
          .map((entry) => ({
            id: String(entry.visitedAt),
            visitId: String(entry.visitedAt),
            visitTime: entry.visitedAt,
            referringVisitId: '0',
            transition: 'link',
          })),
      );
    }
    return { handled: false };
  }

  // ── downloads ──────────────────────────────────────────────────────────────────────────────
  private tell(event: string, args: unknown[]): void {
    for (const extension of this.service.active()) {
      if (this.has(extension, 'downloads')) this.context.fire(extension.summary.id, event, args);
    }
  }

  /** Follows one download from its start to its end and tells the extensions that hold the permission. */
  private track(download: WebKit.Download, by: string | undefined): DownloadItem {
    const known = this.downloadIds.get(download);
    const existing = known === undefined ? undefined : this.downloadList.get(known);
    if (existing) return existing.item;
    const url = download.get_request().get_uri();
    const item: DownloadItem = {
      id: ++this.downloadCount,
      url,
      finalUrl: url,
      filename: '',
      state: 'in_progress',
      bytesReceived: 0,
      totalBytes: -1,
      fileSize: -1,
      startTime: new Date().toISOString(),
      ...(by === undefined ? {} : { byExtensionId: by }),
      mime: '',
      exists: false,
      paused: false,
      canResume: false,
      danger: 'safe',
      incognito: false,
    };
    this.downloadList.set(item.id, { item, download });
    this.downloadIds.set(download, item.id);
    this.tell('downloads.onCreated', [item]);
    const changed = (fields: Record<string, unknown>): void => {
      this.tell('downloads.onChanged', [{ id: item.id, ...fields }]);
    };
    download.connect('created-destination', (_download, destination) => {
      item.filename = destination;
      changed({ filename: { previous: '', current: destination } });
    });
    download.connect('received-data', (_download, length) => {
      item.bytesReceived += length;
      const total = download.get_response()?.get_content_length() ?? 0;
      if (total > 0) {
        item.totalBytes = total;
        item.fileSize = total;
      }
    });
    download.connect('finished', () => {
      item.state = 'complete';
      item.exists = true;
      item.endTime = new Date().toISOString();
      if (item.totalBytes < 0) item.totalBytes = item.bytesReceived;
      changed({
        state: { previous: 'in_progress', current: 'complete' },
        endTime: { current: item.endTime },
      });
    });
    download.connect('failed', (_download, error) => {
      item.state = 'interrupted';
      item.error = 'NETWORK_FAILED';
      changed({
        state: { previous: 'in_progress', current: 'interrupted' },
        error: { current: error.message },
      });
    });
    return item;
  }

  private downloads(extension: LoadedExtension, call: ExtensionCall): ExtrasAnswer {
    this.require(extension, 'downloads');
    switch (call.op) {
      case 'downloads.download': {
        const { url } = (call.options ?? {}) as { url?: string };
        if (typeof url !== 'string' || !/^https?:/i.test(url)) {
          throw new Error('Only http and https addresses can be downloaded.');
        }
        // The browser's own download handler decides where it goes and never overwrites a file.
        const download = this.session.download_uri(url);
        return done(this.track(download, extension.summary.id).id);
      }
      case 'downloads.search': {
        const query = (call.query ?? {}) as {
          id?: number;
          url?: string;
          urlRegex?: string;
          filename?: string;
          state?: string;
          query?: string[];
          limit?: number;
          orderBy?: string[];
        };
        let items = [...this.downloadList.values()].map((entry) => entry.item);
        if (query.id !== undefined) items = items.filter((item) => item.id === query.id);
        if (query.url !== undefined) items = items.filter((item) => item.url === query.url);
        if (query.urlRegex !== undefined) {
          const pattern = new RegExp(query.urlRegex);
          items = items.filter((item) => pattern.test(item.url));
        }
        if (query.filename !== undefined)
          items = items.filter((item) => item.filename === query.filename);
        if (query.state !== undefined) items = items.filter((item) => item.state === query.state);
        for (const term of query.query ?? []) {
          const negative = term.startsWith('-');
          const needle = (negative ? term.slice(1) : term).toLowerCase();
          items = items.filter(
            (item) => `${item.url} ${item.filename}`.toLowerCase().includes(needle) !== negative,
          );
        }
        items.sort((a, b) => b.id - a.id);
        return done(items.slice(0, query.limit ?? 1000));
      }
      case 'downloads.cancel': {
        this.downloadList.get(Number(call.id))?.download.cancel();
        return done(undefined);
      }
      case 'downloads.erase': {
        const query = (call.query ?? {}) as { id?: number };
        const erased: number[] = [];
        for (const [id, entry] of [...this.downloadList]) {
          if (entry.item.state === 'in_progress') continue;
          if (query.id !== undefined && query.id !== id) continue;
          this.downloadList.delete(id);
          erased.push(id);
          this.tell('downloads.onErased', [id]);
        }
        return done(erased);
      }
      case 'downloads.open':
      case 'downloads.show': {
        const entry = this.downloadList.get(Number(call.id));
        const target = entry?.item.filename
          ? call.op === 'downloads.open'
            ? entry.item.filename
            : GLib.path_get_dirname(entry.item.filename)
          : GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
        if (target) Gio.AppInfo.launch_default_for_uri(`file://${target}`, null);
        return done(undefined);
      }
      default:
        return { handled: false };
    }
  }

  // ── browsingData ───────────────────────────────────────────────────────────────────────────
  private async browsingData(
    extension: LoadedExtension,
    call: ExtensionCall,
  ): Promise<ExtrasAnswer> {
    this.require(extension, 'browsingData');
    const data = (call.data ?? {}) as Record<string, boolean>;
    const since = ((call.options ?? {}) as { since?: number }).since ?? 0;
    const types = WebKit.WebsiteDataTypes;
    let mask = 0;
    if (data.cache) mask |= types.MEMORY_CACHE | types.DISK_CACHE | types.OFFLINE_APPLICATION_CACHE;
    if (data.cookies) mask |= types.COOKIES;
    if (data.localStorage) mask |= types.LOCAL_STORAGE | types.SESSION_STORAGE;
    if (data.indexedDB) mask |= types.INDEXEDDB_DATABASES;
    if (data.serviceWorkers) mask |= types.SERVICE_WORKER_REGISTRATIONS;
    if (mask !== 0) {
      const span = since > 0 ? Math.max(0, Date.now() - since) * 1000 : 0;
      await this.session.get_website_data_manager().clear(mask, span, null);
    }
    if (data.history) this.history.clear();
    return done(undefined);
  }

  // ── sessions ───────────────────────────────────────────────────────────────────────────────
  private sessions(call: ExtensionCall): ExtrasAnswer {
    const closed = this.host.recentlyClosed();
    if (call.op === 'sessions.getRecentlyClosed') {
      const max = ((call.filter ?? {}) as { maxResults?: number }).maxResults ?? 25;
      return done(
        closed.slice(0, max).map((url, index) => ({
          lastModified: Math.floor(Date.now() / 1000) - index,
          tab: {
            sessionId: String(index),
            id: -1,
            index: 0,
            windowId: 1,
            url,
            title: '',
            active: false,
            highlighted: false,
            pinned: false,
            incognito: false,
          },
        })),
      );
    }
    if (call.op === 'sessions.restore') {
      const url = closed[Number(call.id)];
      if (url === undefined) throw new Error(`Invalid session id: "${String(call.id)}".`);
      this.host.createTab(url, true);
      return done(undefined);
    }
    return { handled: false };
  }

  // ── power ──────────────────────────────────────────────────────────────────────────────────
  private power(extension: LoadedExtension, call: ExtensionCall): ExtrasAnswer {
    this.require(extension, 'power');
    const { id } = extension.summary;
    const held = this.keepAwake.get(id);
    if (held !== undefined) {
      this.app.uninhibit(held);
      this.keepAwake.delete(id);
    }
    if (call.op === 'power.keepAwake') {
      const cookie = this.app.inhibit(
        this.app.get_active_window(),
        call.level === 'system'
          ? Gtk.ApplicationInhibitFlags.SUSPEND
          : Gtk.ApplicationInhibitFlags.IDLE,
        `${extension.summary.name} asked the screen to stay awake`,
      );
      if (cookie !== 0) this.keepAwake.set(id, cookie);
    }
    return done(undefined);
  }

  // ── search ─────────────────────────────────────────────────────────────────────────────────
  private search(extension: LoadedExtension, call: ExtensionCall): ExtrasAnswer {
    this.require(extension, 'search');
    const info = (call.info ?? {}) as { text?: string; disposition?: string };
    const url = this.context.searchUrl(info.text ?? '');
    const active = this.host.listTabs().find((tab) => tab.active);
    if (info.disposition === 'CURRENT_TAB' && active) this.host.updateTab(active.id, url);
    else this.host.createTab(url, true);
    return done(undefined);
  }

  // ── management ─────────────────────────────────────────────────────────────────────────────
  private info(extension: LoadedExtension): Record<string, unknown> {
    const { summary, manifest, meta } = extension;
    return {
      id: summary.id,
      name: summary.name,
      shortName: summary.name,
      description: summary.description,
      version: summary.version,
      mayDisable: true,
      enabled: meta.enabled,
      isApp: false,
      type: 'extension',
      installType: meta.source === 'store' ? 'normal' : 'development',
      permissions: (manifest.permissions ?? []).filter(
        (item) => !item.includes('://') && item !== '<all_urls>',
      ),
      hostPermissions: hostsOf(manifest),
      offlineEnabled: true,
      optionsUrl: summary.hasOptions ? `webswitch-ext://${summary.id}/` : '',
    };
  }

  private management(extension: LoadedExtension, call: ExtensionCall): ExtrasAnswer {
    if (call.op === 'management.getSelf') return done(this.info(extension));
    this.require(extension, 'management');
    if (call.op === 'management.getAll') {
      return done(this.service.active().map((item) => this.info(item)));
    }
    if (call.op === 'management.get') {
      const found = this.service.get(String(call.id));
      if (!found) throw new Error('Failed to get extension.');
      return done(this.info(found));
    }
    return { handled: false };
  }

  // ── windows: there is one ──────────────────────────────────────────────────────────────────
  private windows(call: ExtensionCall): ExtrasAnswer {
    const size = this.context.windowSize();
    const window = (populate: boolean): Record<string, unknown> => ({
      id: 1,
      focused: true,
      incognito: false,
      alwaysOnTop: false,
      state: 'normal',
      type: 'normal',
      left: 0,
      top: 0,
      width: size.width,
      height: size.height,
      ...(populate ? { tabs: this.host.listTabs() } : {}),
    });
    const populate = (call.info as { populate?: boolean } | undefined)?.populate === true;
    switch (call.op) {
      case 'windows.getAll':
        return done([window(populate)]);
      case 'windows.get':
      case 'windows.getCurrent':
      case 'windows.getLastFocused':
        return done(window(populate));
      case 'windows.create': {
        const { url } = (call.props ?? {}) as { url?: string | string[] };
        for (const target of ([] as string[]).concat(url ?? [])) this.host.createTab(target, true);
        return done(window(true));
      }
      case 'windows.update':
        return done(window(false));
      default:
        return done(undefined);
    }
  }

  // ── permissions asked for while running ────────────────────────────────────────────────────
  private covers(extension: LoadedExtension, origin: string): boolean {
    const hosts = hostsOf(extension.manifest);
    return (
      hosts.includes(origin) ||
      reachesEverySite(hosts) ||
      matchesAny(hosts, origin.replace(/\*/g, 'x'))
    );
  }

  private async permissions(
    extension: LoadedExtension,
    call: ExtensionCall,
  ): Promise<ExtrasAnswer> {
    const request = (call.request ?? {}) as { permissions?: string[]; origins?: string[] };
    const permissions = request.permissions ?? [];
    const origins = request.origins ?? [];
    const granted = (): boolean =>
      permissions.every((item) => this.has(extension, item)) &&
      origins.every((origin) => this.covers(extension, origin));
    switch (call.op) {
      case 'permissions.contains':
        return done(granted());
      case 'permissions.getAll':
        return done({
          permissions: (extension.manifest.permissions ?? []).filter(
            (item) => !item.includes('://') && item !== '<all_urls>',
          ),
          origins: hostsOf(extension.manifest),
        });
      case 'permissions.request': {
        if (granted()) return done(true);
        const optional = new Set(extension.manifest.optional_permissions ?? []);
        const optionalHosts = new Set(extension.manifest.optional_host_permissions ?? []);
        if (
          !permissions.every((item) => optional.has(item)) ||
          !origins.every((origin) => optionalHosts.has(origin) || optional.has(origin))
        ) {
          throw new Error('Only permissions listed as optional in the manifest can be requested.');
        }
        if (!(await this.context.ask(extension, permissions, origins))) return done(false);
        await this.service.grant(extension.summary.id, permissions, origins);
        return done(true);
      }
      case 'permissions.remove':
        await this.service.revoke(extension.summary.id, permissions, origins);
        return done(true);
      default:
        return { handled: false };
    }
  }

  // ── commands (the shortcuts an extension asks for) ─────────────────────────────────────────
  private commands(extension: LoadedExtension): ExtrasAnswer {
    const list = Object.entries(extension.manifest.commands ?? {}).map(([name, command]) => ({
      name,
      description: command.description ?? '',
      shortcut: (commandShortcut(command) ?? '').replace(/^Ctrl\+/, 'Ctrl+'),
    }));
    return done(list);
  }

  // ── the extension's toolbar button ─────────────────────────────────────────────────────────
  private iconData(extension: LoadedExtension, path: unknown): string | null {
    const relative =
      typeof path === 'string'
        ? path
        : typeof path === 'object' && path !== null
          ? Object.entries(path as Record<string, string>).sort(
              (a, b) => Number(b[0]) - Number(a[0]),
            )[0]?.[1]
          : undefined;
    if (typeof relative !== 'string' || relative.includes('..')) return null;
    try {
      const [, bytes] = GLib.file_get_contents(
        GLib.build_filenamev([extension.files, relative.replace(/^\//, '')]),
      );
      if (bytes.length > 300_000) return null;
      const type = relative.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png';
      return `data:${type};base64,${GLib.base64_encode(bytes)}`;
    } catch {
      return null;
    }
  }

  private action(extension: LoadedExtension, call: ExtensionCall): ExtrasAnswer {
    const { id } = extension.summary;
    const state = this.service.action(id);
    const value = call.value;
    switch (call.op) {
      case 'action.setText':
        this.service.setAction(id, { badge: typeof value === 'string' ? value : '' });
        return done(undefined);
      case 'action.setTitle':
        this.service.setAction(id, { title: typeof value === 'string' ? value : '' });
        return done(undefined);
      case 'action.setColor': {
        const color = Array.isArray(value)
          ? `rgba(${String(value[0])}, ${String(value[1])}, ${String(value[2])}, ${String(Number(value[3] ?? 255) / 255)})`
          : typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)
            ? value
            : '';
        this.service.setAction(id, { badgeColor: color });
        return done(undefined);
      }
      case 'action.setIcon':
        this.service.setAction(id, { icon: this.iconData(extension, value) });
        return done(undefined);
      case 'action.setPopup':
        this.service.setAction(id, {
          popup: typeof value === 'string' && value !== '' ? value : null,
        });
        return done(undefined);
      case 'action.getText':
        return done(state.badge);
      case 'action.getTitle':
        return done(state.title || extension.summary.name);
      case 'action.getColor':
        return done([0, 0, 0, 255]);
      case 'action.getPopup':
        return done(state.popup ?? '');
      default:
        return { handled: false };
    }
  }
}
