import type { DevToolsProviderDefinition } from '~types/devtools';

/**
 * The developer tools Webswitch can open on F12. `builtin` ones come with the engine; `download`
 * ones are Chrome-style frontends: a copy comes with the app, and the user can replace it with any
 * release from the npm registry (fetched only on request) or uninstall it.
 */
export const DEVTOOLS_PROVIDERS = [
  {
    id: 'chrome',
    source: 'download',
    name: 'Chrome DevTools',
    description:
      'The DevTools of Google Chrome, docked under the page: Elements, Console, Network, Application. It reaches the page through a script that runs in it (Chii), so there is no debugger with breakpoints, and a page whose Content-Security-Policy forbids eval cannot run Console commands. The DevTools of Opera and Edge are this same frontend. A release comes with Webswitch; install any other release from the npm registry (older ones too) or uninstall it.',
  },
  {
    id: 'webkit',
    source: 'builtin',
    name: 'Safari Web Inspector (WebKit)',
    description:
      "The engine's own inspector, the same code as Safari's Web Inspector: debugger with breakpoints, timelines, storage, layers. Built in, nothing to download.",
  },
] as const satisfies readonly DevToolsProviderDefinition[];

export const DEFAULT_DEVTOOLS_PROVIDER = 'chrome';
