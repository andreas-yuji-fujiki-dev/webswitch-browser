import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import WebKit from 'gi://WebKit?version=6.0';
import { matchesAny } from '~shared/match-pattern';
import { EXTENSION_SCHEME } from '../../core/config';
import { debug } from '../../core/debug';
import type { ExtensionRuntime } from './extension-runtime';

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  txt: 'text/plain',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/**
 * Serves an extension's files under `webswitch-ext://<id>/`. The extension's own pages (its
 * background, popup and options) may read everything in it; any other page only what the manifest
 * lists as web_accessible_resources, like in Chrome, so a site cannot find out which extensions are
 * installed by asking for their files.
 */
export function registerExtensionScheme(runtime: ExtensionRuntime): void {
  const context = WebKit.WebContext.get_default();
  const security = context.get_security_manager();
  security.register_uri_scheme_as_secure(EXTENSION_SCHEME);
  security.register_uri_scheme_as_cors_enabled(EXTENSION_SCHEME);

  context.register_uri_scheme(EXTENSION_SCHEME, (request) => {
    const failure = (code: number, message: string): void => {
      debug('extensions', `${request.get_uri()}: ${String(code)} ${message}`);
      request.finish_error(
        GLib.Error.new_literal(GLib.quark_from_string(EXTENSION_SCHEME), code, message),
      );
    };
    const uri = GLib.Uri.parse(request.get_uri(), GLib.UriFlags.NONE);
    const extension = runtime.extensionFor(uri.get_host() ?? '');
    const segments = uri
      .get_path()
      .split('/')
      .filter((part) => part !== '');
    if (!extension || segments.includes('..')) {
      failure(404, 'Not found');
      return;
    }
    const relative = segments.join('/');

    // A page made for the extension: a background page that has no file of its own.
    if (relative === '_generated_background.html') {
      const html = runtime.backgroundPage(extension.summary.id);
      if (html === null) {
        failure(404, 'Not found');
        return;
      }
      const bytes = new GLib.Bytes(new TextEncoder().encode(html));
      request.finish(Gio.MemoryInputStream.new_from_bytes(bytes), bytes.get_size(), 'text/html');
      return;
    }

    const requester = request.get_web_view();
    const own =
      runtime.isExtensionView(requester) ||
      (requester !== null && runtime.tabOwnsExtension(requester, extension.summary.id));
    if (!own && !runtime.isAccessible(extension, relative)) {
      failure(403, 'Not accessible');
      return;
    }
    const file = Gio.File.new_for_path(GLib.build_filenamev([extension.files, ...segments]));
    if (!file.query_exists(null)) {
      failure(404, 'Not found');
      return;
    }
    const extensionName = file.get_basename()?.split('.').pop()?.toLowerCase() ?? '';
    request.finish(file.read(null), -1, CONTENT_TYPES[extensionName] ?? 'application/octet-stream');
  });
}

/** True when `url` may be fetched by the extension: it matches the hosts the manifest asked for. */
export function allowedHost(hosts: readonly string[], url: string): boolean {
  return matchesAny(hosts, url);
}
