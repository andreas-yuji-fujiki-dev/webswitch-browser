import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import WebKit from 'gi://WebKit?version=6.0';
import { UI_SCHEME } from './config';

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
  json: 'application/json',
};

/**
 * Serves the browser UI (dist/renderer) under webswitch://ui/. A custom scheme, rather than
 * file://, gives the UI a real origin, so its module scripts load and its CSP means something.
 * Only the UI views ever load it: tabs are barred from webswitch: URLs (see webviews.ts).
 */
export function registerUiScheme(root: string): void {
  const context = WebKit.WebContext.get_default();
  const security = context.get_security_manager();
  security.register_uri_scheme_as_secure(UI_SCHEME);
  security.register_uri_scheme_as_cors_enabled(UI_SCHEME);

  context.register_uri_scheme(UI_SCHEME, (request) => {
    const failure = (code: number, message: string): void => {
      request.finish_error(
        GLib.Error.new_literal(GLib.quark_from_string(UI_SCHEME), code, message),
      );
    };

    const path = GLib.Uri.parse(request.get_uri(), GLib.UriFlags.NONE).get_path();
    const segments = path.split('/').filter((part) => part !== '');
    if (segments.includes('..')) {
      failure(403, 'Forbidden');
      return;
    }
    const file = Gio.File.new_for_path(
      GLib.build_filenamev([root, ...(segments.length > 0 ? segments : ['index.html'])]),
    );
    if (!file.query_exists(null)) {
      failure(404, 'Not found');
      return;
    }
    const extension = file.get_basename()?.split('.').pop() ?? '';
    request.finish(file.read(null), -1, CONTENT_TYPES[extension] ?? 'application/octet-stream');
  });
}
