/**
 * Chrome extension match patterns ("https://*.example.com/*", "<all_urls>"): which pages an extension
 * may run on. Only http, https and file pages are ever matched.
 */

import type { CompiledPattern } from '~types/extensions';

const SCHEMES = ['http', 'https', 'file'];

const escape = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

function compile(pattern: string): CompiledPattern | null {
  if (pattern === '<all_urls>') return { schemes: SCHEMES, host: null, path: /^.*$/ };
  const found = /^(\*|https?|file):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!found) return null;
  const [, scheme = '', host = '', path = ''] = found;
  if (scheme !== 'file' && host === '') return null;
  let hostPattern: RegExp | null = null;
  if (host !== '*' && scheme !== 'file') {
    if (host.startsWith('*.'))
      hostPattern = new RegExp(`^(?:[^.]+\\.)*${escape(host.slice(2))}$`, 'i');
    else if (host.includes('*')) return null;
    else hostPattern = new RegExp(`^${escape(host)}$`, 'i');
  }
  return {
    schemes: scheme === '*' ? ['http', 'https'] : [scheme],
    host: hostPattern,
    path: new RegExp(`^${path.split('*').map(escape).join('.*')}$`),
  };
}

/** True when `pattern` is a well-formed match pattern. */
export function isMatchPattern(pattern: unknown): boolean {
  return typeof pattern === 'string' && compile(pattern) !== null;
}

/** Does `url` match any of the patterns? (Query and hash count for the path, as in Chrome.) */
export function matchesAny(patterns: readonly string[], url: string): boolean {
  const parsed = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^#]*)/i.exec(url);
  if (!parsed) return false;
  const scheme = (parsed[1] ?? '').toLowerCase();
  const host = (parsed[2] ?? '').replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  const rest = parsed[3] ?? '';
  const path = rest === '' ? '/' : rest;
  return patterns.some((pattern) => {
    const compiled = compile(pattern);
    if (!compiled?.schemes.includes(scheme)) return false;
    if (compiled.host && !compiled.host.test(host)) return false;
    return compiled.path.test(path);
  });
}

/**
 * The patterns in the form WebKit's script allow-lists take, or null for "every page". A pattern
 * for both http and https becomes two.
 */
export function toWebKitPatterns(patterns: readonly string[]): string[] | null {
  if (patterns.includes('<all_urls>')) return null;
  const out: string[] = [];
  for (const pattern of patterns) {
    if (!isMatchPattern(pattern)) continue;
    if (pattern.startsWith('*://')) {
      out.push(`http://${pattern.slice(4)}`, `https://${pattern.slice(4)}`);
    } else {
      out.push(pattern);
    }
  }
  return out;
}

/** True when the pattern list reaches every website. */
export function reachesEverySite(patterns: readonly string[]): boolean {
  return patterns.some(
    (pattern) => pattern === '<all_urls>' || /^(\*|https?):\/\/\*\/\*$/.test(pattern),
  );
}
