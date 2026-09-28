import type { BrowserDefinition } from '~types/browsers';

/**
 * The browsers Webswitch can install to test a page in. `download` ones are fetched from the
 * vendor on the user's request, kept in a folder of their own, and can be updated, switched to
 * another release or uninstalled. `builtin` is the engine Webswitch itself runs.
 */
export const BROWSERS = [
  {
    id: 'chrome',
    name: 'Chrome',
    engine: 'Blink',
    tier: 'main',
    source: 'download',
    description:
      "Chrome for Testing: Google's official build for testing web pages, with any release since 113 to pick from. The same engine and DevTools as Chrome (and Edge, Opera, Brave). Comes with Widevine, so it also plays Netflix and Spotify.",
  },
  {
    id: 'firefox',
    name: 'Firefox',
    engine: 'Gecko',
    tier: 'main',
    source: 'download',
    description:
      "Mozilla's own release, the newest or an older one, with the ESR line. The only engine besides Blink and WebKit, so a page that works here works in the third of the web that is not Chrome or Safari.",
  },
  {
    id: 'webkit',
    name: 'WebKit',
    engine: 'WebKit',
    tier: 'main',
    source: 'builtin',
    description:
      "The engine Webswitch itself runs (WebKitGTK). It is the same family as Safari's engine, so it is the closest you can get to Safari on Linux, but it is not identical: Safari is only made for Apple systems and its feature flags and release dates differ.",
  },
  {
    id: 'opera',
    name: 'Opera',
    engine: 'Blink',
    tier: 'extra',
    source: 'download',
    description:
      "Opera's own release. It is Chromium underneath, so the engine is Chrome's; it is here for what Opera adds on top (its own features, defaults and release versions).",
  },
  {
    id: 'edge',
    name: 'Edge',
    engine: 'Blink',
    tier: 'extra',
    source: 'download',
    description:
      "Microsoft Edge for Linux. It is Chromium underneath, so the engine is Chrome's; it is here for Microsoft's defaults and release versions. Big: about 830 MB installed.",
  },
] as const satisfies readonly BrowserDefinition[];
