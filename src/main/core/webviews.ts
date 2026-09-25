import type Gdk from 'gi://Gdk?version=4.0';
import type Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';
import { UI_HOST, UI_SCHEME } from './config';
import { DEBUG, debug } from './debug';
import type { IpcRouter } from './ipc-router';
import type { PermissionsService } from '../features/permissions/permissions.service';

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
    /** Takes a page this engine cannot play (DRM); true when another program opened it. */
    handOff: (url: string, source: WebKit.WebView) => boolean;
  },
  related?: WebKit.WebView,
): WebKit.WebView {
  const view = related
    ? new WebKit.WebView({ related_view: related })
    : new WebKit.WebView({ network_session: deps.session, settings: tabSettings() });
  view.set_hexpand(true);
  view.set_vexpand(true);

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
      if (uri.startsWith(`${UI_SCHEME}:`)) {
        debug('policy', `blocked navigation to ${uri}`);
        decision.ignore();
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
    }
    return false;
  });
  return view;
}

/** Debug-only: what a page's requests, certificates and content do. */
function traceView(view: WebKit.WebView): void {
  view.connect('resource-load-started', (_view, resource) => {
    resource.connect('failed', (_resource, error) => {
      debug('resource-failed', `${resource.get_uri()}  ${error.message}`);
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

function tabSettings(): WebKit.Settings {
  const settings = baseSettings();
  // Right click > Inspect Element, F12 and the remote inspector all depend on this.
  settings.set_enable_developer_extras(true);
  return settings;
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
