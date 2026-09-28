import type Gdk from 'gi://Gdk?version=4.0';
import type Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';
import { DEVTOOLS_SCHEME, EXTENSION_SCHEME, UI_HOST, UI_SCHEME } from './config';
import { DEBUG, debug } from './debug';
import type { IpcRouter } from './ipc-router';
import type { PermissionsService } from '../features/permissions/permissions.service';
import type { RequestVerdict } from '~types/extensions';
import type { SettingsReader } from '~types/settings';
import { applyStartupTabPreferences, applyTabPreferences } from './preferences';

// A `create` handler that refuses to open a window returns NULL, which the typings do not allow.
const NO_WINDOW = null as unknown as Gtk.Widget;

/** Settings shared by every view: no file access from pages, no console noise, no DNS prefetch. */
function baseSettings(): WebKit.Settings {
  return new WebKit.Settings({
    allow_file_access_from_file_urls: false,
    allow_universal_access_from_file_urls: false,
    enable_dns_prefetching: false,
    // A page's console.log and errors go to the terminal only while debugging.
    enable_write_console_messages_to_stdout: DEBUG,
  });
}

/**
 * A view for a tab: a plain web view with no script bridge, so a page can never reach the
 * browser's API, and no way to load the browser's own webswitch:// pages.
 * `related` (for `window.open`) keeps the new view linked to the page that opened it.
 */
export function createTabView(
  deps: {
    session: WebKit.NetworkSession;
    permissions: PermissionsService;
    prefs: SettingsReader;
    /** Takes a page this engine cannot play (DRM); true when another program opened it. */
    handOff: (url: string, source: WebKit.WebView) => boolean;
    /** A promise when cookies must be restored before `url` is requested, else null. */
    prepareNavigation: (url: string) => Promise<void> | null;
    /** Puts the installed extensions' scripts, styles and rules into the view. */
    attachExtensions: (view: WebKit.WebView) => void;
    /** A tab wants to load `webswitch-ext://...`: true only for a navigation the extension itself
     * asked for (`tabs.create`/`tabs.update`) or already owns, never a foreign page's link/redirect. */
    allowExtensionNavigation: (view: WebKit.WebView, uri: string) => boolean;
    /** A site asks for a username and password; true when somebody is dealing with it. */
    authenticate: (view: WebKit.WebView, request: WebKit.AuthenticationRequest) => boolean;
    /** A page or frame is about to load: an extension may block it or send it elsewhere (null: nobody minds). */
    interceptNavigation: (
      view: WebKit.WebView,
      url: string,
      type: 'main_frame' | 'sub_frame',
    ) => RequestVerdict | Promise<RequestVerdict> | null;
    /** The page itself answered, just with an error status (404, 403, 500...) — shown instead of
     * whatever the server's own error page would have been. */
    reportHttpError: (view: WebKit.WebView, url: string, status: number) => void;
  },
  related?: WebKit.WebView,
): WebKit.WebView {
  const view = related
    ? new WebKit.WebView({ related_view: related })
    : new WebKit.WebView({ network_session: deps.session, settings: baseSettings() });
  // Also for a view that only follows an opener: it starts with default settings.
  const settings = view.get_settings();
  applyStartupTabPreferences(settings, deps.prefs);
  applyTabPreferences(settings, deps.prefs);
  view.set_hexpand(true);
  view.set_vexpand(true);
  deps.attachExtensions(view);
  view.connect('authenticate', (_view, request) => deps.authenticate(view, request));

  view.connect('permission-request', (_view, request) =>
    deps.permissions.decide(view.get_uri(), request),
  );
  if (DEBUG) traceView(view);
  view.connect('decide-policy', (_view, decision, type) => {
    if (
      type === WebKit.PolicyDecisionType.NAVIGATION_ACTION ||
      type === WebKit.PolicyDecisionType.NEW_WINDOW_ACTION
    ) {
      const action = (decision as WebKit.NavigationPolicyDecision).get_navigation_action();
      const uri = action.get_request().get_uri() ?? '';
      if (uri.startsWith(`${UI_SCHEME}:`) || uri.startsWith(`${DEVTOOLS_SCHEME}:`)) {
        debug('policy', `blocked navigation to ${uri}`);
        decision.ignore();
        return true;
      }
      if (uri.startsWith(`${EXTENSION_SCHEME}:`) && !deps.allowExtensionNavigation(view, uri)) {
        debug('policy', `blocked navigation to ${uri}`);
        decision.ignore();
        return true;
      }
      // An extension may block this page or send it elsewhere (the answer can take a moment).
      const verdict = deps.interceptNavigation(
        view,
        uri,
        action.get_frame_name() ? 'sub_frame' : 'main_frame',
      );
      if (verdict !== null) {
        const apply = (answer: RequestVerdict): void => {
          if (answer.cancel === true) {
            debug('policy', `extension blocked ${uri}`);
            decision.ignore();
          } else if (answer.redirectUrl !== undefined) {
            debug('policy', `extension sent ${uri} to ${answer.redirectUrl}`);
            decision.ignore();
            view.load_uri(answer.redirectUrl);
          } else {
            decision.use();
          }
        };
        if ('then' in verdict) {
          void verdict.then(apply, () => {
            decision.use();
          });
        } else {
          apply(verdict);
        }
        return true;
      }
      // A clicked link, decided before any request leaves; redirects are caught by the tabs service.
      if (
        action.get_navigation_type() === WebKit.NavigationType.LINK_CLICKED &&
        deps.handOff(uri, view)
      ) {
        debug('policy', `link to ${uri} handed to the DRM browser`);
        decision.ignore();
        return true;
      }
      // Clicked links and form posts wait for the cookies that are only allowed on the target site.
      const kind = action.get_navigation_type();
      if (
        kind === WebKit.NavigationType.LINK_CLICKED ||
        kind === WebKit.NavigationType.FORM_SUBMITTED
      ) {
        const pending = deps.prepareNavigation(uri);
        if (pending) {
          // The decision is answered later; WebKit keeps waiting while the object is referenced.
          void pending.then(
            () => {
              decision.use();
            },
            () => {
              decision.use();
            },
          );
          return true;
        }
      }
    } else if (type === WebKit.PolicyDecisionType.RESPONSE) {
      const responseDecision = decision as WebKit.ResponsePolicyDecision;
      // The server answered (no network-level failure), just with an error status: the page would
      // otherwise render whatever the server's own error page is, so this is reported before the
      // page ever draws it. Only the top-level document counts — a 404'd image or script is normal.
      if (responseDecision.is_main_frame_main_resource()) {
        const response = responseDecision.get_response();
        if (response.status_code >= 400) {
          deps.reportHttpError(view, response.get_uri() ?? '', response.status_code);
        }
      }
      // A known WebKitGTK gotcha: unlike a navigation action, a RESPONSE decision (headers received,
      // before the body downloads) is not approved by default just because nothing here handles it —
      // leaving one undecided can cancel the load outright, main document included. This app never
      // wants to refuse or redirect a response to something else here (downloads are handled
      // separately, through the session's own `download-started` signal), so every response the
      // browser did not already decide something about above is explicitly approved.
      decision.use();
      return true;
    }
    return false;
  });
  return view;
}

/** Debug-only: what a page's requests, certificates and content do. */
function traceView(view: WebKit.WebView): void {
  // Diagnostic for the youtube.com "blank on first load" bug: whoever calls stop_loading() on this
  // view leaves a stack trace here, and a failed resource says whether it was the main document
  // itself (as opposed to some subresource, which is routinely cancelled and harmless).
  const stopLoading = view.stop_loading.bind(view);
  view.stop_loading = (): void => {
    debug(
      'stop-loading',
      `${view.get_uri() ?? ''}\n${new Error('stop_loading() called from').stack ?? ''}`,
    );
    stopLoading();
  };
  view.connect('decide-policy', (_view, decision, type) => {
    const uri =
      type === WebKit.PolicyDecisionType.NAVIGATION_ACTION ||
      type === WebKit.PolicyDecisionType.NEW_WINDOW_ACTION
        ? ((decision as WebKit.NavigationPolicyDecision)
            .get_navigation_action()
            .get_request()
            .get_uri() ?? '')
        : type === WebKit.PolicyDecisionType.RESPONSE
          ? ((decision as WebKit.ResponsePolicyDecision).get_response().get_uri() ?? '')
          : '';
    debug('policy-seen', `type=${String(type)} uri=${uri}`);
    return false;
  });
  view.connect('resource-load-started', (_view, resource) => {
    resource.connect('failed', (_resource, error) => {
      const main = resource.get_uri() === view.get_uri() ? ' MAIN-FRAME' : '';
      debug('resource-failed', `${resource.get_uri()}${main}  ${error.message}`);
    });
    resource.connect('failed-with-tls-errors', (_resource, _certificate, errors) => {
      debug('resource-tls-error', `${resource.get_uri()}  errors=${errors}`);
    });
    resource.connect('finished', () => {
      const status = resource.get_response()?.get_status_code() ?? 0;
      if (status >= 400) debug('http', `${status} ${resource.get_uri()}`);
    });
  });
  view.connect('load-failed-with-tls-errors', (_view, uri, _certificate, errors) => {
    debug('tls-error', `${uri}  errors=${errors}`);
    return false;
  });
  view.connect('insecure-content-detected', (_view, event) => {
    debug('insecure-content', `${view.get_uri() ?? ''}  event=${event}`);
  });
}

/**
 * A view for the browser's own UI (the main UI and the menu). It gets the preload script that
 * builds `window.browserApi`, is locked to webswitch://ui/ and can open nothing.
 * `related` (the menu) shares the main UI's web process, script bridge and settings, which saves
 * a whole web process; both are the browser's own pages, so they trust each other anyway.
 */
export function createUiView(
  deps: { session: WebKit.NetworkSession; router: IpcRouter; preload: string },
  background: Gdk.RGBA,
  related?: WebKit.WebView,
): WebKit.WebView {
  let view: WebKit.WebView;
  if (related) {
    // A related view shares the web process, but not the script bridge: hand that over too.
    view = new WebKit.WebView({
      related_view: related,
      user_content_manager: related.get_user_content_manager(),
    });
    deps.router.track(view);
  } else {
    const manager = new WebKit.UserContentManager();
    manager.add_script(
      new WebKit.UserScript(
        deps.preload,
        WebKit.UserContentInjectedFrames.TOP_FRAME,
        WebKit.UserScriptInjectionTime.START,
        null,
        null,
      ),
    );
    const settings = baseSettings();
    // Inspecting the UI is how user.css authors find the selectors to style. Off unless debugging.
    settings.set_enable_developer_extras(DEBUG);
    view = new WebKit.WebView({
      network_session: deps.session,
      user_content_manager: manager,
      settings,
    });
    deps.router.attach(view, manager);
  }
  view.set_background_color(background);
  view.set_hexpand(true);
  view.set_vexpand(true);

  view.connect('decide-policy', (_view, decision, type) => {
    if (type === WebKit.PolicyDecisionType.RESPONSE) return false;
    const action = (decision as WebKit.NavigationPolicyDecision).get_navigation_action();
    const uri = action.get_request().get_uri() ?? '';
    if (uri.startsWith(`${UI_SCHEME}://${UI_HOST}/`)) return false;
    decision.ignore();
    return true;
  });
  view.connect('create', () => NO_WINDOW);
  view.connect('context-menu', () => !DEBUG);
  return view;
}
