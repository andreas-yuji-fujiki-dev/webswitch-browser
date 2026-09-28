import { urlFilterToRegex } from './dnr';
import type { DnrRule, NavigationVerdict } from '~types/extensions';

const URL_PARTS =
  /^([a-z][a-z0-9+.-]*):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/:?#]*)(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/i;

function hostOf(url: string): string {
  return (URL_PARTS.exec(url)?.[4] ?? '').toLowerCase();
}

function inDomains(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => {
    const wanted = domain.toLowerCase().replace(/^\./, '');
    return host === wanted || host.endsWith(`.${wanted}`);
  });
}

function matchesUrl(
  condition: NonNullable<DnrRule['condition']>,
  url: string,
): RegExpExecArray | null {
  const flags = condition.isUrlFilterCaseSensitive === true ? '' : 'i';
  try {
    if (condition.regexFilter !== undefined)
      return new RegExp(condition.regexFilter, flags).exec(url);
    if (condition.urlFilter !== undefined) {
      const source = urlFilterToRegex(condition.urlFilter);
      return source === null ? null : new RegExp(source, flags).exec(url);
    }
  } catch {
    return null;
  }
  return /(?:)/.exec(url);
}

/** The address a redirect action leads to, or null when it cannot be worked out. */
function redirectTarget(
  rule: DnrRule,
  url: string,
  match: RegExpExecArray,
  extensionBase: string,
): string | null {
  const redirect = rule.action?.redirect;
  if (!redirect) return null;
  if (typeof redirect.url === 'string') return redirect.url;
  if (typeof redirect.extensionPath === 'string') {
    return `${extensionBase}${redirect.extensionPath.replace(/^\//, '')}`;
  }
  if (typeof redirect.regexSubstitution === 'string') {
    return redirect.regexSubstitution.replace(
      /\\(\d)/g,
      (_all, n: string) => match[Number(n)] ?? '',
    );
  }
  const transform = redirect.transform;
  const parts = URL_PARTS.exec(url);
  if (!transform || !parts) return null;
  const scheme = transform.scheme ?? parts[1] ?? '';
  const username = transform.username ?? parts[2] ?? '';
  const password = transform.password ?? parts[3] ?? '';
  const host = transform.host ?? parts[4] ?? '';
  const port = transform.port ?? parts[5] ?? '';
  const path = transform.path ?? parts[6] ?? '';
  let query = transform.query ?? parts[7] ?? '';
  const fragment = transform.fragment ?? parts[8] ?? '';
  const changes = transform.queryTransform;
  if (changes && transform.query === undefined) {
    const pairs = query
      .replace(/^\?/, '')
      .split('&')
      .filter((pair) => pair !== '');
    const keyOf = (pair: string): string => decodeURIComponent(pair.split('=')[0] ?? '');
    let kept = pairs.filter((pair) => !(changes.removeParams ?? []).includes(keyOf(pair)));
    for (const add of changes.addOrReplaceParams ?? []) {
      const encoded = `${encodeURIComponent(add.key)}=${encodeURIComponent(add.value)}`;
      const found = kept.some((pair) => keyOf(pair) === add.key);
      if (found) kept = kept.map((pair) => (keyOf(pair) === add.key ? encoded : pair));
      else if (add.replaceOnly !== true) kept.push(encoded);
    }
    query = kept.length > 0 ? `?${kept.join('&')}` : '';
  }
  const login = username === '' ? '' : `${username}${password === '' ? '' : `:${password}`}@`;
  return `${scheme}://${login}${host}${port === '' ? '' : `:${port}`}${path}${query}${fragment}`;
}

const RANK = { allow: 3, block: 2, redirect: 1 } as const;

/**
 * What declarativeNetRequest rules decide about a page (or frame) that is about to load: the highest
 * priority rule that matches wins, and at the same priority allowing beats blocking beats redirecting.
 * Only rules that name the type explicitly can match a main frame, like in Chrome.
 */
export function navigationVerdict(
  rules: readonly DnrRule[],
  url: string,
  type: 'main_frame' | 'sub_frame',
  extensionBase: string,
): NavigationVerdict {
  const host = hostOf(url);
  let best: { priority: number; rank: number; verdict: NavigationVerdict } | null = null;
  for (const rule of rules) {
    const kind = rule.action?.type;
    const rank =
      kind === 'allow' || kind === 'allowAllRequests'
        ? RANK.allow
        : kind === 'block'
          ? RANK.block
          : kind === 'redirect'
            ? RANK.redirect
            : 0;
    if (rank === 0) continue;
    const condition = rule.condition ?? {};
    const types = condition.resourceTypes;
    if (types === undefined ? type === 'main_frame' : !types.includes(type)) continue;
    if (condition.excludedResourceTypes?.includes(type) === true) continue;
    // A navigation has no initiator page to compare with, so a rule that needs one does not apply.
    if (condition.initiatorDomains && condition.initiatorDomains.length > 0) continue;
    if (condition.requestDomains && !inDomains(host, condition.requestDomains)) continue;
    if (condition.excludedRequestDomains && inDomains(host, condition.excludedRequestDomains))
      continue;
    const match = matchesUrl(condition, url);
    if (!match) continue;
    const priority = rule.priority ?? 1;
    if (best && (priority < best.priority || (priority === best.priority && rank <= best.rank)))
      continue;
    let verdict: NavigationVerdict;
    if (rank === RANK.allow) verdict = { kind: 'allow' };
    else if (rank === RANK.block) verdict = { kind: 'block' };
    else {
      const target = redirectTarget(rule, url, match, extensionBase);
      // A transform rule that changes nothing for this particular URL (Ghostery's query-cleaning
      // rules do this often) must not "redirect" the page to the address it is already at: WebKit
      // and the browser have no way to tell that apart from a real navigation and reload the page
      // forever, once per rule that matches on every load.
      if (target === null || target === url) continue;
      verdict = { kind: 'redirect', url: target };
    }
    best = { priority, rank, verdict };
  }
  return best?.verdict ?? null;
}
