import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import WebKit from 'gi://WebKit?version=6.0';
import { DEVTOOLS_SCHEME } from '../../core/config';
import type { DevToolsService } from './devtools.service';

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  json: 'application/json',
  map: 'application/json',
  wasm: 'application/wasm',
  txt: 'text/plain',
};

/**
 * Serves the frontend of the developer tools under webswitch-devtools://<provider>/. Only the
 * DevTools panel's own view loads it: tabs are barred from this scheme (see webviews.ts), and
 * `target.js` (the script that runs in the inspected page) is never served, only read natively.
 */
export function registerDevToolsScheme(service: DevToolsService): void {
  const context = WebKit.WebContext.get_default();
  const security = context.get_security_manager();
  security.register_uri_scheme_as_secure(DEVTOOLS_SCHEME);
  security.register_uri_scheme_as_cors_enabled(DEVTOOLS_SCHEME);

  context.register_uri_scheme(DEVTOOLS_SCHEME, (request) => {
    const failure = (code: number, message: string): void => {
      request.finish_error(
        GLib.Error.new_literal(GLib.quark_from_string(DEVTOOLS_SCHEME), code, message),
      );
    };
    const uri = GLib.Uri.parse(request.get_uri(), GLib.UriFlags.NONE);
    const root = service.frontendDir(uri.get_host() ?? '');
    const segments = uri
      .get_path()
      .split('/')
      .filter((part) => part !== '');
    if (root === null || segments.includes('..') || segments[0] !== 'front_end') {
      failure(404, 'Not found');
      return;
    }
    const file = Gio.File.new_for_path(GLib.build_filenamev([root, ...segments]));
    if (!file.query_exists(null)) {
      failure(404, 'Not found');
      return;
    }
    const extension = file.get_basename()?.split('.').pop() ?? '';
    request.finish(file.read(null), -1, CONTENT_TYPES[extension] ?? 'application/octet-stream');
  });
}
