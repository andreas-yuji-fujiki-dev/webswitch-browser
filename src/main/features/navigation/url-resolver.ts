import { parseUrl } from '../../core/url';
import type { SearchEngine } from '~types/navigation';

const DIRECT_SCHEME = /^(?:https?|file):\/\//i;
const HOST_LIKE =
  /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\]|(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*)(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/**
 * Turns whatever the user typed into a URL to load: an explicit URL, a bare host ("example.com",
 * "localhost:3000") or a search query. Returns null for empty input.
 * Other schemes (javascript:, data:, ...) are deliberately treated as a search, never executed.
 */
export function resolveInput(input: string, searchEngine: SearchEngine): string | null {
  const text = input.trim();
  if (text === '') return null;

  if (text === 'about:blank' || DIRECT_SCHEME.test(text)) {
    return isValidUrl(text) ? text : searchUrl(text, searchEngine);
  }

  if (HOST_LIKE.test(text)) {
    const candidate = `${prefersHttp(text) ? 'http' : 'https'}://${text}`;
    if (isValidUrl(candidate)) return candidate;
  }

  return searchUrl(text, searchEngine);
}

function searchUrl(query: string, engine: SearchEngine): string {
  return engine.urlTemplate.replace('%s', encodeURIComponent(query));
}

function isValidUrl(value: string): boolean {
  return parseUrl(value) !== null;
}

/** Local development hosts rarely have TLS; everything else defaults to https. */
function prefersHttp(hostAndRest: string): boolean {
  const host = /^(\[[^\]]+\]|[^:/?#]+)/.exec(hostAndRest)?.[1]?.toLowerCase() ?? '';
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.startsWith('[') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  );
}
