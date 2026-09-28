import Gio from 'gi://Gio?version=2.0';
import WebKit from 'gi://WebKit?version=6.0';
import type { Http } from '../../core/http';
import type { LoadedExtension, ProxyChoice, ProxyServer } from '~types/extensions';

const HOST = /^[A-Za-z0-9.\-:[\]_]+$/;
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, socks4: 1080, socks5: 1080 };
/** Chrome never sends these through a proxy that an extension chose. */
const ALWAYS_DIRECT = ['localhost', '127.0.0.1', '::1'];

/** `chrome.proxy`: a proxy an extension chose for all pages, in place until it lets go or is turned off. */
export class ExtensionProxy {
  private choice: ProxyChoice | null = null;

  constructor(
    private readonly session: WebKit.NetworkSession,
    private readonly http: Http,
    /** Called when the proxy in force changed (the page and the toolbar show it). */
    private readonly changed: (choice: ProxyChoice | null) => void,
    /** Tells the owner its setting changed. */
    private readonly notify: (extension: string, details: unknown) => void,
  ) {}

  current(): ProxyChoice | null {
    return this.choice;
  }

  get(extension: string): { value: Record<string, unknown>; levelOfControl: string } {
    if (!this.choice) {
      return { value: { mode: 'system' }, levelOfControl: 'controllable_by_this_extension' };
    }
    return {
      value: this.choice.value,
      levelOfControl:
        this.choice.extension === extension
          ? 'controlled_by_this_extension'
          : 'controlled_by_other_extensions',
    };
  }

  set(extension: LoadedExtension, value: Record<string, unknown>): void {
    const description = this.apply(value, extension.summary.name);
    this.choice = { extension: extension.summary.id, value, description };
    this.changed(this.choice);
    this.notify(extension.summary.id, {
      value,
      levelOfControl: 'controlled_by_this_extension',
    });
  }

  /** The extension lets go (or, with no id, the user pressed Stop): the system's settings come back. */
  clear(extension?: string): void {
    if (!this.choice || (extension !== undefined && this.choice.extension !== extension)) return;
    const owner = this.choice.extension;
    this.choice = null;
    this.session.set_proxy_settings(WebKit.NetworkProxyMode.DEFAULT, null);
    this.http.useProxy(null);
    this.changed(null);
    this.notify(owner, {
      value: { mode: 'system' },
      levelOfControl: 'controllable_by_this_extension',
    });
  }

  private uri(server: ProxyServer, fallbackScheme = 'http'): string {
    const scheme = server.scheme ?? fallbackScheme;
    const known = scheme === 'quic' ? 'http' : scheme;
    if (!(known in DEFAULT_PORTS)) throw new Error(`Unsupported proxy scheme: ${scheme}`);
    if (typeof server.host !== 'string' || !HOST.test(server.host)) {
      throw new Error('The proxy host is not valid.');
    }
    const port = server.port ?? DEFAULT_PORTS[known] ?? 0;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('The proxy port is not valid.');
    }
    return `${known}://${server.host.includes(':') && !server.host.startsWith('[') ? `[${server.host}]` : server.host}:${String(port)}`;
  }

  /** Puts the setting in force in the pages and in the requests the browser makes for extensions. */
  private apply(value: Record<string, unknown>, who: string): string {
    const mode = value.mode;
    if (mode === 'direct') {
      this.session.set_proxy_settings(WebKit.NetworkProxyMode.NO_PROXY, null);
      this.http.useProxy(new Gio.SimpleProxyResolver());
      return `Pages go out directly, without any proxy (set by ${who}).`;
    }
    if (mode === 'system' || mode === 'auto_detect') {
      this.session.set_proxy_settings(WebKit.NetworkProxyMode.DEFAULT, null);
      this.http.useProxy(null);
      return `The system's proxy settings are used (set by ${who}).`;
    }
    if (mode === 'pac_script') {
      throw new Error('Proxy auto-config (PAC) scripts are not supported in Webswitch yet.');
    }
    if (mode !== 'fixed_servers') throw new Error('Unknown proxy mode.');
    const rules = (value.rules ?? {}) as {
      singleProxy?: ProxyServer;
      proxyForHttp?: ProxyServer;
      proxyForHttps?: ProxyServer;
      proxyForFtp?: ProxyServer;
      fallbackProxy?: ProxyServer;
      bypassList?: string[];
    };
    const bypass = [
      ...ALWAYS_DIRECT,
      ...(rules.bypassList ?? []).flatMap((entry) =>
        entry === '<local>' ? [] : [entry.replace(/^\*\./, '.')],
      ),
    ];
    const main = rules.singleProxy ?? rules.fallbackProxy;
    const fallback = main ? this.uri(main) : null;
    const settings = new WebKit.NetworkProxySettings(fallback, bypass);
    const resolver = new Gio.SimpleProxyResolver({
      ...(fallback === null ? {} : { default_proxy: fallback }),
      ignore_hosts: bypass,
    });
    const describe: string[] = [];
    if (fallback) describe.push(fallback);
    if (!rules.singleProxy) {
      for (const [scheme, server] of [
        ['http', rules.proxyForHttp],
        ['https', rules.proxyForHttps],
        ['ftp', rules.proxyForFtp],
      ] as const) {
        if (!server) continue;
        const target = this.uri(server);
        settings.add_proxy_for_scheme(scheme, target);
        resolver.set_uri_proxy(scheme, target);
        describe.push(`${scheme}: ${target}`);
      }
    }
    if (describe.length === 0) throw new Error('No proxy server was given.');
    this.session.set_proxy_settings(WebKit.NetworkProxyMode.CUSTOM, settings);
    this.http.useProxy(resolver);
    return `All pages go through ${describe.join(', ')} (set by ${who}).`;
  }
}
