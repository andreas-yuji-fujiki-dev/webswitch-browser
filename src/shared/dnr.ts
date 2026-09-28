import type { BlockerRule, DnrRule } from '~types/extensions';

/**
 * Turns the static rules of a Manifest V3 extension (declarativeNetRequest) into WebKit content
 * blocker rules, which WebKit compiles and applies itself. What cannot be said in that format is
 * skipped and counted: redirects, header changes, and patterns with alternation or repeats.
 */

const TYPES: Record<string, string[]> = {
  main_frame: ['document'],
  sub_frame: ['document'],
  stylesheet: ['style-sheet'],
  script: ['script'],
  image: ['image'],
  font: ['font'],
  object: ['other'],
  xmlhttprequest: ['raw'],
  ping: ['ping'],
  csp_report: ['ping'],
  media: ['media'],
  websocket: ['raw'],
  webtransport: ['raw'],
  webbundle: ['other'],
  other: ['other'],
};
// A rule that names no types applies to everything but the page itself.
const NOT_THE_PAGE = ['image', 'style-sheet', 'script', 'font', 'raw', 'media', 'ping', 'other'];
const MAX_RULES = 150_000;

/** A DNR `urlFilter` (`||host^path*`, `|start`, `end|`) as the regular expression WebKit takes, or null. */
export function urlFilterToRegex(filter: string): string | null {
  let rest = filter;
  let out = '';
  if (rest.startsWith('||')) {
    out = '^[a-z]+://([^/]*\\.)?';
    rest = rest.slice(2);
  } else if (rest.startsWith('|')) {
    out = '^';
    rest = rest.slice(1);
  }
  const anchoredEnd = rest.endsWith('|');
  if (anchoredEnd) rest = rest.slice(0, -1);
  for (const character of rest) {
    if (character === '*') out += '.*';
    // DNR's "^" means one separator character (anything but a letter, digit, "_.%-"): a character
    // class says that precisely, but WebKit's content blocker cannot parse a character class at all
    // ("Character class is not supported", confirmed against a real, large ruleset — every rule
    // using one, ours included, silently failed and got logged, over and over, once per attempt the
    // recovery in `ExtensionDnr.compile()` makes while bisecting for the *other* unreadable rules,
    // which is where the flood of repeated identical errors on every startup came from). A plain
    // "any one character" is looser (a rule may fire one character early on a run of separators)
    // but is the closest WebKit can actually read.
    else if (character === '^') out += '.';
    else if (character === '|') return null;
    else if (/[.+?()[\]{}\\$]/.test(character)) out += `\\${character}`;
    else out += character;
  }
  return anchoredEnd ? `${out}$` : out === '' ? '.*' : out;
}

/** A `regexFilter` when it only uses what WebKit understands, else null. */
function safeRegex(regex: string): string | null {
  return /[|]|\(\?|\{|\\b/.test(regex) ? null : regex;
}

/**
 * A pattern WebKit's content blocker can read: ASCII, no alternation, counted repeats, word
 * boundaries, lookaheads, backreferences, or character classes — confirmed against a real ruleset,
 * WebKit refuses those with "Character class is not supported" and drops the whole rule. That
 * covers both spellings: explicit brackets (`[a-z]`) and the shorthand escapes (`\d`, `\w`, `\s`
 * and their negations) are each a character class as far as WebKit's own regex reader is concerned.
 */
function isReadablePattern(pattern: string): boolean {
  return /^[\x20-\x7e]*$/.test(pattern) && !/[|{}[\]]|\\[bdswDSW]|\(\?|\\[1-9]/.test(pattern);
}

export function dnrToContentBlocker(rules: readonly DnrRule[]): {
  rules: BlockerRule[];
  skipped: number;
} {
  const converted: { priority: number; allow: boolean; rules: BlockerRule[] }[] = [];
  let skipped = 0;
  for (const rule of rules) {
    const kind = rule.action?.type;
    const condition = rule.condition ?? {};
    const action: BlockerRule['action']['type'] | null =
      kind === 'block'
        ? 'block'
        : kind === 'allow' || kind === 'allowAllRequests'
          ? 'ignore-previous-rules'
          : kind === 'upgradeScheme'
            ? 'make-https'
            : null;
    if (action === null) {
      skipped++;
      continue;
    }
    // Where the request goes: a URL pattern, a regular expression, or a list of hosts.
    const filters: string[] = [];
    if (condition.urlFilter !== undefined) {
      const regex = urlFilterToRegex(condition.urlFilter);
      if (regex === null) {
        skipped++;
        continue;
      }
      filters.push(regex);
    } else if (condition.regexFilter !== undefined) {
      const regex = safeRegex(condition.regexFilter);
      if (regex === null) {
        skipped++;
        continue;
      }
      filters.push(regex);
    } else if (condition.requestDomains && condition.requestDomains.length > 0) {
      for (const domain of condition.requestDomains) {
        filters.push(`^[a-z]+://([^/]*\\.)?${domain.replace(/\./g, '\\.')}`);
      }
    } else {
      filters.push('.*');
    }

    // WebKit refuses a whole blocker for one pattern it cannot read: keep only what it understands.
    const readable = filters.filter(isReadablePattern);
    const domains = [
      ...(condition.initiatorDomains ?? condition.domains ?? []),
      ...(condition.excludedInitiatorDomains ?? condition.excludedDomains ?? []),
    ];
    if (readable.length === 0 || !domains.every((domain) => /^[a-z0-9.*-]+$/i.test(domain))) {
      skipped++;
      continue;
    }
    filters.length = 0;
    filters.push(...readable);

    let types: string[] | undefined;
    if (condition.resourceTypes) {
      types = [...new Set(condition.resourceTypes.flatMap((type) => TYPES[type] ?? []))];
    } else if (condition.excludedResourceTypes) {
      const excluded = new Set(
        condition.excludedResourceTypes.flatMap((type) => TYPES[type] ?? []),
      );
      types = NOT_THE_PAGE.filter((type) => !excluded.has(type));
    } else {
      types = NOT_THE_PAGE;
    }
    if (types.length === 0) {
      skipped++;
      continue;
    }
    const inside = condition.initiatorDomains ?? condition.domains;
    const outside = condition.excludedInitiatorDomains ?? condition.excludedDomains;
    const made: BlockerRule[] = filters.map((filter) => ({
      trigger: {
        'url-filter': filter,
        ...(condition.isUrlFilterCaseSensitive === true
          ? { 'url-filter-is-case-sensitive': true }
          : {}),
        'resource-type': types,
        ...(condition.domainType === 'thirdParty'
          ? { 'load-type': ['third-party'] }
          : condition.domainType === 'firstParty'
            ? { 'load-type': ['first-party'] }
            : {}),
        // WebKit takes either list, not both.
        ...(inside && inside.length > 0
          ? { 'if-domain': inside.map((domain) => `*${domain.toLowerCase()}`) }
          : outside && outside.length > 0
            ? { 'unless-domain': outside.map((domain) => `*${domain.toLowerCase()}`) }
            : {}),
      },
      action: { type: action },
    }));
    converted.push({
      priority: rule.priority ?? 1,
      allow: action === 'ignore-previous-rules',
      rules: made,
    });
  }
  // Later rules win in WebKit: lower priority first, and inside one priority the allowing ones last.
  converted.sort((a, b) => a.priority - b.priority || Number(a.allow) - Number(b.allow));
  const flat = converted.flatMap((entry) => entry.rules);
  if (flat.length > MAX_RULES) skipped += flat.length - MAX_RULES;
  return { rules: flat.slice(0, MAX_RULES), skipped };
}
