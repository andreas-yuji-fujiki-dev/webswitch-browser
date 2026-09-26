import type {
  CookieCompanyDetails,
  CookieCompanyEntry,
  CookieMatch,
  KnownCookie,
} from '~types/cookies';

/** Second-level labels under which the registrable domain has one more label (example.co.uk). */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.br',
  'net.br',
  'org.br',
  'gov.br',
  'edu.br',
  'mil.br',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'co.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'co.in',
  'co.za',
  'ac.za',
  'com.ar',
  'com.mx',
  'com.pt',
  'com.tr',
  'com.cn',
  'com.sg',
  'co.kr',
]);

/** "accounts.google.com.br" -> "google.com.br". A heuristic: there is no public-suffix list here. */
export function registrableDomain(host: string): string {
  const labels = host.replace(/^\./, '').toLowerCase().split('.');
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

const COMPANIES: readonly CookieCompanyEntry[] = [
  {
    name: 'Google',
    domains: [
      'google.',
      'youtube.com',
      'gmail.com',
      'googleapis.com',
      'gstatic.com',
      'doubleclick.net',
      'googleadservices.com',
      'googlesyndication.com',
      'googleusercontent.com',
    ],
    panel: { label: 'Google account panel', url: 'https://myaccount.google.com/' },
    warning:
      'This is part of your Google sign-in. Removing it signs you out of Google (Gmail, YouTube, Drive) and stops "Sign in with Google" from working on other sites until you sign in again.',
  },
  {
    name: 'Microsoft',
    domains: [
      'microsoft.com',
      'live.com',
      'office.com',
      'microsoftonline.com',
      'outlook.com',
      'bing.com',
      'msn.com',
      'azure.com',
      'sharepoint.com',
      'xbox.com',
      'skype.com',
      'office365.com',
    ],
    panel: { label: 'Microsoft account panel', url: 'https://account.microsoft.com/' },
    warning:
      'This is part of your Microsoft sign-in. Removing it signs you out of Microsoft services (Outlook, Office, Azure) and of sites that use "Sign in with Microsoft" until you sign in again.',
  },
  {
    name: 'Meta',
    domains: [
      'facebook.com',
      'instagram.com',
      'meta.com',
      'messenger.com',
      'whatsapp.com',
      'fbcdn.net',
    ],
    panel: { label: 'Meta accounts center', url: 'https://accountscenter.facebook.com/' },
  },
  {
    name: 'Apple',
    domains: ['apple.com', 'icloud.com'],
    panel: { label: 'Apple account', url: 'https://account.apple.com/' },
  },
  {
    name: 'Amazon',
    domains: ['amazon.', 'primevideo.com', 'amazonaws.com'],
    panel: { label: 'Amazon account', url: 'https://www.amazon.com/gp/css/homepage.html' },
  },
  {
    name: 'GitHub',
    domains: ['github.com', 'githubusercontent.com'],
    panel: { label: 'GitHub settings', url: 'https://github.com/settings/profile' },
  },
  {
    name: 'LinkedIn',
    domains: ['linkedin.com'],
    panel: { label: 'LinkedIn settings', url: 'https://www.linkedin.com/psettings/' },
  },
  {
    name: 'X (Twitter)',
    domains: ['x.com', 'twitter.com', 'twimg.com'],
    panel: { label: 'X account settings', url: 'https://x.com/settings/account' },
  },
  {
    name: 'Spotify',
    domains: ['spotify.com', 'scdn.co'],
    panel: { label: 'Spotify account', url: 'https://www.spotify.com/account/overview/' },
  },
  {
    name: 'Netflix',
    domains: ['netflix.com'],
    panel: { label: 'Netflix account', url: 'https://www.netflix.com/account' },
  },
  {
    name: 'Dropbox',
    domains: ['dropbox.com'],
    panel: { label: 'Dropbox account', url: 'https://www.dropbox.com/account' },
  },
  {
    name: 'Reddit',
    domains: ['reddit.com'],
    panel: { label: 'Reddit settings', url: 'https://www.reddit.com/settings/account' },
  },
  {
    name: 'Adobe',
    domains: ['adobe.com'],
    panel: { label: 'Adobe account', url: 'https://account.adobe.com/' },
  },
  { name: 'Cloudflare', domains: ['cloudflare.com'] },
  { name: 'Discord', domains: ['discord.com', 'discordapp.com'] },
];

function findCompany(host: string): CookieCompanyEntry | undefined {
  const domain = registrableDomain(host);
  return COMPANIES.find((company) =>
    company.domains.some((entry) =>
      entry.endsWith('.') ? domain.startsWith(entry) : domain === entry,
    ),
  );
}

/** The company that owns `host`, or the site's own registrable domain when it is not a known one. */
export function companyOf(host: string): string {
  return findCompany(host)?.name ?? registrableDomain(host);
}

/** Company details for the UI; unknown sites are their own "company" with no account panel. */
export function companyInfo(name: string): CookieCompanyDetails {
  const known = COMPANIES.find((company) => company.name === name);
  return {
    name,
    accountPanel: known?.panel ?? null,
    removalWarning:
      known?.warning ?? `Removing it signs you out of ${name}; you will have to log in again.`,
  };
}

// Cookies whose purpose is documented publicly by their owners, by exact name.
const KNOWN_BY_NAME: Record<string, KnownCookie> = {
  SID: {
    kind: 'authentication',
    explanation:
      'Google account session ID. Together with HSID and SSID it proves you are signed in, and it is checked on every request to Google.',
  },
  HSID: {
    kind: 'authentication',
    explanation:
      'Google account session ID, sent only over secure connections and hidden from page scripts; it helps stop forged requests made in your name.',
  },
  SSID: {
    kind: 'authentication',
    explanation:
      'Google account session ID for secure connections; used with SID and HSID to keep you signed in.',
  },
  APISID: {
    kind: 'authentication',
    explanation:
      'Authenticates requests that Google services make on your behalf from other sites (for example an embedded YouTube player).',
  },
  SAPISID: {
    kind: 'authentication',
    explanation:
      'Like APISID, for secure connections: lets Google APIs and embedded Google content know who you are.',
  },
  LSID: {
    kind: 'authentication',
    explanation:
      'Google Accounts sign-in cookie, used on accounts.google.com to manage your login.',
  },
  '__Secure-1PSID': {
    kind: 'authentication',
    explanation:
      'The current Google session ID for first-party use (google.com, youtube.com). Signing out of Google deletes it.',
  },
  '__Secure-3PSID': {
    kind: 'authentication',
    explanation:
      'The current Google session ID for use in third-party contexts, such as "Sign in with Google" on other sites.',
  },
  '__Secure-1PAPISID': {
    kind: 'authentication',
    explanation: 'Google API authentication for first-party requests.',
  },
  '__Secure-3PAPISID': {
    kind: 'authentication',
    explanation:
      'Google API authentication for third-party contexts (embedded Google content on other sites).',
  },
  '__Secure-1PSIDTS': {
    kind: 'security',
    explanation:
      'A timestamp that Google refreshes to check that your session is still valid and has not been stolen.',
  },
  '__Secure-3PSIDTS': {
    kind: 'security',
    explanation: 'Same as __Secure-1PSIDTS, for third-party contexts.',
  },
  '__Secure-1PSIDCC': {
    kind: 'security',
    explanation: 'Google session security check that changes often, to detect a copied session.',
  },
  '__Secure-3PSIDCC': {
    kind: 'security',
    explanation: 'Same as __Secure-1PSIDCC, for third-party contexts.',
  },
  SIDCC: {
    kind: 'security',
    explanation: 'Google session security check that changes often, to detect a copied session.',
  },
  '__Host-GAPS': {
    kind: 'authentication',
    explanation: 'Google account sign-in state on accounts.google.com.',
  },
  ACCOUNT_CHOOSER: {
    kind: 'preferences',
    explanation:
      'Remembers which Google accounts you used on this browser, for the account picker.',
  },
  NID: {
    kind: 'preferences',
    explanation:
      'Google preferences (language, search settings). For signed-out visitors it also carries an ID used for personalised ads.',
  },
  CONSENT: {
    kind: 'preferences',
    explanation: 'Remembers your answer to the cookie consent banner.',
  },
  SOCS: { kind: 'preferences', explanation: 'Remembers your cookie consent choices for Google.' },
  AEC: {
    kind: 'security',
    explanation:
      'Helps Google detect spam and abuse so it can protect the service and your session.',
  },
  '1P_JAR': { kind: 'analytics', explanation: 'Google statistics and conversion tracking.' },
  MUID: {
    kind: 'analytics',
    explanation: 'Microsoft unique browser ID, used for analytics and ads across Microsoft sites.',
  },
  MSPAuth: { kind: 'authentication', explanation: 'Microsoft account sign-in token.' },
  ESTSAUTH: {
    kind: 'authentication',
    explanation: 'Microsoft Entra ID / Azure AD session while you sign in.',
  },
  ESTSAUTHPERSISTENT: {
    kind: 'authentication',
    explanation: 'Microsoft Entra ID / Azure AD "keep me signed in" session.',
  },
  c_user: {
    kind: 'authentication',
    explanation: 'Your Facebook user ID: identifies which account is signed in.',
  },
  xs: {
    kind: 'authentication',
    explanation: 'Facebook session secret, paired with c_user to keep you signed in.',
  },
  datr: {
    kind: 'security',
    explanation: 'Identifies your browser to Facebook to detect suspicious logins.',
  },
  li_at: { kind: 'authentication', explanation: 'LinkedIn sign-in session token.' },
  user_session: { kind: 'authentication', explanation: 'GitHub sign-in session.' },
  logged_in: {
    kind: 'preferences',
    explanation:
      'Tells GitHub whether a session exists (yes/no); the real login is in user_session.',
  },
  auth_token: { kind: 'authentication', explanation: 'X (Twitter) sign-in token.' },
  sp_dc: { kind: 'authentication', explanation: 'Spotify web player sign-in cookie.' },
  NetflixId: { kind: 'authentication', explanation: 'Netflix sign-in session.' },
  MoodleSession: {
    kind: 'authentication',
    explanation:
      'Moodle sign-in session: identifies you to the learning platform until you log out.',
  },
  PHPSESSID: {
    kind: 'authentication',
    explanation: 'PHP session ID: links your requests to your login state stored on the server.',
  },
  JSESSIONID: {
    kind: 'authentication',
    explanation:
      'Java server session ID: links your requests to your login state stored on the server.',
  },
  'ASP.NET_SessionId': {
    kind: 'authentication',
    explanation: 'ASP.NET session ID: links your requests to your login state on the server.',
  },
  '.AspNet.Cookies': { kind: 'authentication', explanation: 'ASP.NET sign-in ticket.' },
  laravel_session: {
    kind: 'authentication',
    explanation: 'Laravel session: keeps you signed in and holds temporary form data.',
  },
  'connect.sid': { kind: 'authentication', explanation: 'Express (Node.js) session ID.' },
  __cf_bm: {
    kind: 'security',
    explanation:
      'Cloudflare bot management: tells humans from automated traffic. Expires after 30 minutes.',
  },
  cf_clearance: {
    kind: 'security',
    explanation:
      'Cloudflare: proof that you passed its browser check, so you are not challenged again.',
  },
};

const PATTERNS: readonly { test: RegExp; known: KnownCookie }[] = [
  {
    test: /^_ga(_.*)?$|^_gid$|^_gat|^_gcl_|^_fbp$|^_fbc$|^_hj|^ajs_|^amplitude|^mp_.*_mixpanel$/i,
    known: {
      kind: 'analytics',
      explanation:
        'Analytics or ad measurement: counts visits and tells returning visitors apart. It does not keep you signed in.',
    },
  },
  {
    test: /csrf|xsrf/i,
    known: {
      kind: 'security',
      explanation:
        'Anti-forgery token: the site compares it with a hidden value in its forms so other sites cannot submit requests in your name.',
    },
  },
  {
    test: /session|sess_?id|^sid$|_sid$|sessid/i,
    known: {
      kind: 'authentication',
      explanation:
        'A session ID: the server uses it to recognise you between requests and remember that you are logged in. Removing it logs you out.',
    },
  },
  {
    test: /token|jwt|bearer|^auth|_auth$|refresh|remember|login|access/i,
    known: {
      kind: 'authentication',
      explanation:
        'A token that proves you are logged in (or asks the site to remember you). Anyone who has it can act as you, so it is sensitive.',
    },
  },
  {
    test: /^(lang|locale|language|theme|pref|consent|cookieconsent|cookie_consent|gdpr|optanon)/i,
    known: {
      kind: 'preferences',
      explanation:
        'Remembers a choice you made on the site, such as language, theme or cookie consent.',
    },
  },
];

const UNKNOWN: KnownCookie = {
  kind: 'other',
  explanation:
    'Webswitch does not recognise this cookie. Only the site that set it knows exactly what it holds.',
};

/** Guesses what a cookie is from its name and flags. Names Webswitch does not know stay "other". */
export function describeCookie(
  name: string,
  domain: string,
  flags: { httpOnly: boolean; secure: boolean; session: boolean },
): CookieMatch {
  const known = KNOWN_BY_NAME[name] ?? PATTERNS.find((pattern) => pattern.test.test(name))?.known;
  const base = known ?? {
    ...UNKNOWN,
    explanation:
      flags.httpOnly && flags.secure
        ? `${UNKNOWN.explanation} It is HttpOnly and Secure: page scripts cannot read it and it only travels over HTTPS, which is typical of session data.`
        : UNKNOWN.explanation,
  };
  return { company: companyOf(domain), kind: base.kind, explanation: base.explanation };
}
