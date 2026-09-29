import type Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import WebKit from 'gi://WebKit?version=6.0';
import { DEVTOOLS_SCHEME } from '../../core/config';
import { debug } from '../../core/debug';
import { dataDir, cacheDir } from '../../core/paths';
import type { MainWindow } from '../../core/window';
import {
  FRONTEND_OPEN,
  FRONTEND_SHIM,
  PAGE_BRIDGE,
  PAGE_READY,
  PAGE_SHIM,
  deliverToFrontend,
  deliverToPage,
} from './devtools-scripts';
import type { DevToolsService } from './devtools.service';
import type { DevToolsSession } from '~types/devtools';

/** The script world the inspected page's messages are collected in; the page's own scripts cannot see it. */
const BRIDGE_WORLD = 'ws-devtools';
const HANDLER = 'wsdevtools';

/**
 * Chrome DevTools docked under the page: a web view showing the DevTools frontend, connected to
 * the inspected page through scripts and a small message bridge (see devtools-scripts.ts). One
 * panel per tab; only the active tab's is showing.
 */
export class DevToolsPanelService {
  private readonly sessions = new Map<WebKit.WebView, DevToolsSession>();
  private readonly bridged = new Set<WebKit.UserContentManager>();
  private readonly targetScripts = new Map<string, string>();
  private network: WebKit.NetworkSession | null = null;

  constructor(
    private readonly main: MainWindow,
    private readonly devtools: DevToolsService,
    /** The browser's own UI: it draws the home page and the built-in pages, so it is inspected there. */
    private readonly ui: WebKit.WebView,
    private background: Gdk.RGBA,
    /** Opens a link the frontend asked for in a tab. */
    private readonly openLink: (url: string) => void,
  ) {}

  /** A new theme: the panels being shown take the new background too. */
  setBackground(background: Gdk.RGBA): void {
    this.background = background;
    for (const session of this.sessions.values()) session.frontend.set_background_color(background);
  }

  isOpen(host: WebKit.WebView): boolean {
    return this.sessions.has(host);
  }

  stats(host: WebKit.WebView): { fromPage: number; toPage: number } | null {
    const session = this.sessions.get(host);
    return session ? { fromPage: session.fromPage, toPage: session.toPage } : null;
  }

  frontendOf(host: WebKit.WebView): WebKit.WebView | null {
    return this.sessions.get(host)?.frontend ?? null;
  }

  /** `tabId` is the tab the tools were opened from: they belong to that tab and to no other. */
  toggle(host: WebKit.WebView, tabId: number): void {
    const session = this.sessions.get(host);
    if (session) this.close(session);
    else this.open(host, tabId);
  }

  /**
   * Shows the active tab's panel (when it has one and its page is on screen), hides the others,
   * and drops the panels of tabs that were closed.
   */
  sync(
    active: WebKit.WebView | null,
    pageShowing: boolean,
    live: ReadonlySet<WebKit.WebView>,
    activeTabId: number | null,
  ): void {
    for (const session of [...this.sessions.values()]) {
      // A tab's own page goes when the tab does. The UI is shared by the home page and the built-in
      // pages, so what is inspected there goes as soon as another tab is shown.
      const gone =
        session.host === this.ui ? session.tabId !== activeTabId : !live.has(session.host);
      if (gone) this.close(session);
    }
    // A web page is inspected in its own view; the home page, a built-in page or an error is the UI's.
    const host = pageShowing ? active : this.ui;
    const session = host ? this.sessions.get(host) : undefined;
    this.main.setDevToolsPanel(session?.frontend ?? null);
  }

  private open(host: WebKit.WebView, tabId: number): void {
    const provider = this.devtools.activeProvider();
    const dir = this.devtools.frontendDir(provider);
    if (dir === null) {
      debug('devtools', `no Chrome DevTools files for ${provider}`);
      return;
    }
    const target = this.targetScript(dir);
    if (target === null) return;

    const manager = new WebKit.UserContentManager();
    manager.add_script(
      new WebKit.UserScript(
        FRONTEND_SHIM,
        WebKit.UserContentInjectedFrames.TOP_FRAME,
        WebKit.UserScriptInjectionTime.START,
        null,
        null,
      ),
    );
    manager.register_script_message_handler(HANDLER, null);
    const frontend = new WebKit.WebView({
      user_content_manager: manager,
      network_session: this.networkSession(),
    });
    frontend.set_background_color(this.background);
    frontend.set_hexpand(true);
    frontend.set_vexpand(true);
    frontend.set_visible(false);

    const session: DevToolsSession = {
      host,
      frontend,
      committed: false,
      fromPage: 0,
      toPage: 0,
      tabId,
      pageReady: false,
      queued: [],
    };
    this.sessions.set(host, session);
    this.bridgeHost(host);

    manager.connect(`script-message-received::${HANDLER}`, (_manager, value) => {
      const message = value.to_string();
      if (message === FRONTEND_OPEN) {
        // The frontend (re)started: whatever the page side heard before belongs to the old one.
        session.pageReady = false;
        session.queued = [];
        this.injectIntoPage(session, target);
        return;
      }
      // The frontend asks for things the moment it connects, before the page side listens.
      if (session.pageReady) this.sendToPage(session, message);
      else session.queued.push(message);
    });
    frontend.connect('decide-policy', (_view, decision, type) => {
      if (
        type !== WebKit.PolicyDecisionType.NAVIGATION_ACTION &&
        type !== WebKit.PolicyDecisionType.NEW_WINDOW_ACTION
      ) {
        return false;
      }
      const uri = (decision as WebKit.NavigationPolicyDecision)
        .get_navigation_action()
        .get_request()
        .get_uri();
      if (uri.startsWith(`${DEVTOOLS_SCHEME}:`)) return false;
      // Anything else the frontend links to (documentation, a source URL) opens as a tab.
      decision.ignore();
      if (/^https?:/i.test(uri)) this.openLink(uri);
      return true;
    });
    // A new page is a new target: the frontend starts over once the page has loaded.
    host.connect('load-changed', (_view, event) => {
      if (!this.sessions.has(host)) return;
      if (event === WebKit.LoadEvent.COMMITTED) session.committed = true;
      if (event === WebKit.LoadEvent.FINISHED && session.committed) {
        session.committed = false;
        frontend.reload();
      }
    });

    this.main.setDevToolsPanel(frontend);
    frontend.load_uri(
      `${DEVTOOLS_SCHEME}://${provider}/front_end/chii_app.html?ws=${DEVTOOLS_SCHEME}/client/webswitch?target=webswitch`,
    );
    frontend.grab_focus();
  }

  private close(session: DevToolsSession): void {
    this.sessions.delete(session.host);
    this.main.removeDevToolsPanel(session.frontend);
    const { frontend } = session;
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      frontend.run_dispose();
      return GLib.SOURCE_REMOVE;
    });
  }

  private sendToPage(session: DevToolsSession, message: string): void {
    session.toPage++;
    session.host
      .evaluate_javascript(deliverToPage(message), -1, null, null, null)
      .catch(() => undefined);
  }

  /** One handler per tab's content manager, in a script world the page cannot reach. */
  private bridgeHost(host: WebKit.WebView): void {
    const manager = host.get_user_content_manager();
    if (this.bridged.has(manager)) return;
    this.bridged.add(manager);
    manager.register_script_message_handler(HANDLER, BRIDGE_WORLD);
    manager.connect(`script-message-received::${HANDLER}`, (_manager, value) => {
      const session = this.sessions.get(host);
      if (!session) return;
      const message = value.to_string();
      if (message === PAGE_READY) {
        session.pageReady = true;
        for (const queued of session.queued.splice(0)) this.sendToPage(session, queued);
        return;
      }
      session.fromPage++;
      session.frontend
        .evaluate_javascript(deliverToFrontend(message), -1, null, null, null)
        .catch(() => undefined);
    });
  }

  /** The page side: the socket stand-in, then Chii's target script (chobitsu), in the page's world. */
  private injectIntoPage(session: DevToolsSession, target: string): void {
    const { host } = session;
    host
      .evaluate_javascript(PAGE_BRIDGE, -1, BRIDGE_WORLD, null, null)
      .then(() => host.evaluate_javascript(`${PAGE_SHIM}\n${target}`, -1, null, null, null))
      .catch((error: unknown) => {
        debug('devtools', `could not start the page side: ${String(error)}`);
      });
  }

  private targetScript(dir: string): string | null {
    const cached = this.targetScripts.get(dir);
    if (cached !== undefined) return cached;
    try {
      const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([dir, 'target.js']));
      const source = new TextDecoder().decode(bytes);
      this.targetScripts.set(dir, source);
      return source;
    } catch (error) {
      debug('devtools', `cannot read target.js: ${String(error)}`);
      return null;
    }
  }

  /** The panel's own storage (DevTools remembers its layout and theme), apart from the tabs'. */
  private networkSession(): WebKit.NetworkSession {
    this.network ??= WebKit.NetworkSession.new(
      GLib.build_filenamev([dataDir(), 'devtools-web']),
      GLib.build_filenamev([cacheDir(), 'devtools-web']),
    );
    return this.network;
  }
}
