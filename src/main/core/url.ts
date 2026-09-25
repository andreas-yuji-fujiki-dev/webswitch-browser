import GLib from 'gi://GLib?version=2.0';
import type { ParsedUrl } from '~types/common';

/** Parses an absolute URL, or returns null when `text` is not one. */
export function parseUrl(text: string): ParsedUrl | null {
  try {
    const uri = GLib.Uri.parse(text, GLib.UriFlags.NONE);
    const scheme = uri.get_scheme().toLowerCase();
    const host = uri.get_host();
    const port = uri.get_port();
    const hasHost = host !== null && host !== '';
    // An http(s) URL without a host ("https://") is not a URL a browser can load.
    if ((scheme === 'http' || scheme === 'https') && !hasHost) return null;
    return {
      scheme,
      host: hasHost ? host : null,
      origin: hasHost ? `${scheme}://${host}${port > 0 ? `:${port}` : ''}` : null,
    };
  } catch {
    return null;
  }
}

/** True for pages that live on the web, the only ones history, tabs and popups deal with. */
export function isWebUrl(text: string): boolean {
  const scheme = parseUrl(text)?.scheme;
  return scheme === 'http' || scheme === 'https';
}
