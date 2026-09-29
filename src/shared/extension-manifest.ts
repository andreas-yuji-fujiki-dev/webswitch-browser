import { isMatchPattern, reachesEverySite } from './match-pattern';
import type { ExtensionManifest, ExtensionSummary } from '~types/extensions';

/** API permissions the runtime provides (some only in part; the page says which parts). */
const SUPPORTED = new Set<string>([
  'storage',
  'unlimitedStorage',
  'activeTab',
  'tabs',
  'scripting',
  'alarms',
  'declarativeNetRequest',
  'declarativeNetRequestWithHostAccess',
  'declarativeNetRequestFeedback',
  'webNavigation',
  // Watching requests; blocking or redirecting works for pages and frames, not for what a page loads.
  'webRequest',
  'webRequestBlocking',
  'webRequestAuthProvider',
  'nativeMessaging',
  'cookies',
  'contextMenus',
  'notifications',
  'history',
  'downloads',
  'management',
  'commands',
  'favicon',
  'proxy',
  'userScripts',
  'offscreen',
  'identity',
  'browsingData',
  'sessions',
  'power',
  'search',
  'clipboardWrite',
  'clipboardRead',
  'tabGroups',
  'sidePanel',
  'pageCapture',
]);

/** Permissions that are accepted and do nothing. */
const IGNORED = new Set<string>([
  'idle',
  'fontSettings',
  'topSites',
  'system.cpu',
  'system.memory',
  'system.display',
  'gcm',
  'tts',
  'ttsEngine',
  'privacy',
  'bookmarks',
  'declarativeContent',
  'readingList',
  'contentSettings',
  'printing',
  'enterprise.deviceAttributes',
]);

/** Permissions that cannot work in WebKit, and why it matters. */
const UNSUPPORTED = new Set<string>([
  'debugger',
  'tabCapture',
  'desktopCapture',
  'enterprise.platformKeys',
  'printerProvider',
]);

/** What a permission lets an extension do, in words a person can weigh (shown in red before adding it). */
const RISKS: Record<string, string> = {
  proxy: 'Can send all your browsing through a server it chooses.',
  cookies: 'Can read and change your cookies, including the ones that keep you signed in.',
  history: 'Can read your browsing history.',
  webRequest: 'Sees every request the pages you open make (addresses and headers).',
  webRequestBlocking: 'Can block or redirect the pages and frames you open.',
  webRequestAuthProvider: 'Can answer sites that ask for a username and password.',
  nativeMessaging: 'Can talk to programs on this computer that name it.',
  userScripts: 'Runs scripts (its own or ones you add) inside the pages it reaches.',
  downloads: 'Can start downloads.',
  management: 'Can see which other extensions are installed.',
  tabs: 'Sees the address and title of every open tab.',
  browsingData: 'Can erase your browsing data.',
  sessions: 'Sees the tabs you closed recently.',
  identity: 'Can open sign-in windows for other services.',
  declarativeNetRequest: 'Can block or redirect requests.',
  clipboardRead: 'Can read what you copied.',
  pageCapture: 'Can save a complete copy of any page you have open.',
};

const MAX_NAME = 120;

/** The manifest, or what is wrong with it. Only the fields Webswitch uses are checked. */
export function validateManifest(
  raw: unknown,
): { ok: true; manifest: ExtensionManifest } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'manifest.json is not an object.' };
  }
  const m = raw as Partial<ExtensionManifest>;
  if (m.manifest_version !== 2 && m.manifest_version !== 3) {
    return { ok: false, error: 'Only Manifest V2 and V3 extensions are supported.' };
  }
  if (typeof m.name !== 'string' || m.name.trim() === '' || m.name.length > MAX_NAME * 4) {
    return { ok: false, error: 'The extension has no name.' };
  }
  if (typeof m.version !== 'string' || !/^[0-9][0-9.]{0,40}$/.test(m.version)) {
    return { ok: false, error: 'The extension has no valid version.' };
  }
  return { ok: true, manifest: m as ExtensionManifest };
}

/** Every host the extension asks for, from `host_permissions` and, in V2, from `permissions`. */
export function hostsOf(manifest: ExtensionManifest): string[] {
  const hosts = [...(manifest.host_permissions ?? [])];
  for (const permission of manifest.permissions ?? [])
    if (isMatchPattern(permission)) hosts.push(permission);
  for (const script of manifest.content_scripts ?? []) hosts.push(...(script.matches ?? []));
  return [...new Set(hosts.filter(isMatchPattern))];
}

/** What to tell the user: who can this extension read and change, and what of it will not work. */
export function summarize(
  manifest: ExtensionManifest,
  id: string,
  description: string,
  icon: string | null,
): ExtensionSummary {
  const permissions = [
    ...(manifest.permissions ?? []),
    ...(manifest.optional_permissions ?? []),
  ].filter((permission) => !isMatchPattern(permission));
  const hosts = hostsOf(manifest);
  const action = manifest.action ?? manifest.browser_action ?? manifest.page_action;
  const blocksRequests = false;
  return {
    id,
    name: manifest.name.slice(0, MAX_NAME),
    version: manifest.version,
    description: description.slice(0, 400),
    hostAccess: hosts.length === 0 ? 'none' : reachesEverySite(hosts) ? 'all' : 'sites',
    hosts: hosts.slice(0, 40),
    supported: permissions.filter((permission) => SUPPORTED.has(permission)),
    unsupported: permissions.filter((permission) => UNSUPPORTED.has(permission)),
    ignored: permissions.filter((permission) => IGNORED.has(permission)),
    hasBackground: Boolean(
      manifest.background?.service_worker ??
      manifest.background?.scripts ??
      manifest.background?.page,
    ),
    hasPopup: typeof action?.default_popup === 'string',
    hasAction: action !== undefined,
    hasOptions: typeof (manifest.options_ui?.page ?? manifest.options_page) === 'string',
    contentScripts: manifest.content_scripts?.length ?? 0,
    blocksRequests,
    risks: permissions
      .filter((permission) => permission in RISKS)
      .map((permission) => RISKS[permission] ?? ''),
    icon,
  };
}
