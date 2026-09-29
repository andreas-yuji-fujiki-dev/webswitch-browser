import type { SettingDefinition, SettingSectionId } from '~types/settings';

export const SETTING_SECTIONS: readonly { id: SettingSectionId; label: string }[] = [
  { id: 'performance', label: 'Performance' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'pages', label: 'Pages' },
  { id: 'search', label: 'Search' },
  { id: 'downloads', label: 'Downloads' },
];

/**
 * Every setting the Settings page shows, in order. The defaults describe how Webswitch behaved
 * before the page existed, except where a description says otherwise. `effect` says when a change
 * counts: `restart` ones make the page offer a restart.
 */
export const SETTINGS = [
  {
    id: 'gpuAcceleration',
    section: 'performance',
    kind: 'toggle',
    default: false,
    effect: 'restart',
    label: 'Draw pages with the GPU',
    description:
      'Off draws pages in software: fixed headers do not jump and text does not flicker while scrolling fast on laptops with two GPUs, but canvas and WebGL pages are slower, and on an NVIDIA laptop video can turn solid black on some sites (confirmed on youtube.com). If that happens, turn this on together with "Keep the browser on the integrated GPU" below — video comes back, at the cost of the scrolling flicker returning too. On lets WebKit use the GPU.',
  },
  {
    id: 'integratedGpuOnly',
    section: 'performance',
    kind: 'toggle',
    default: false,
    effect: 'restart',
    label: 'Keep the browser on the integrated GPU',
    description:
      'Hides the discrete graphics card (NVIDIA) from the browser on laptops with two GPUs, which saves battery and, together with "Draw pages with the GPU" above, is what fixes video turning black on some sites on an NVIDIA laptop. Only matters when pages are drawn with the GPU.',
  },
  {
    id: 'smoothScrolling',
    section: 'performance',
    kind: 'toggle',
    default: true,
    effect: 'now',
    label: 'Smooth scrolling',
    description: 'Animates the mouse wheel and keyboard scrolling. Off moves in steps.',
  },
  {
    id: 'pageCache',
    section: 'performance',
    kind: 'toggle',
    default: true,
    effect: 'now',
    label: 'Keep pages for fast Back and Forward',
    description:
      'Keeps the pages you left in memory so going back is instant. Off uses less memory.',
  },
  {
    id: 'embedStreaming',
    section: 'performance',
    kind: 'toggle',
    default: true,
    effect: 'restart',
    label: 'Show other browsers inside the tab (Netflix, Spotify, browsers to test in)',
    description:
      'Netflix, Spotify and similar sites play in a Chrome window shown inside the tab (WebKit has no DRM), and the browsers installed in "Test in other browsers" open pages the same way. Both need Webswitch to run on X11 (XWayland). Off opens streaming sites in a separate Chrome window and keeps native Wayland.',
  },
  {
    id: 'trackingPrevention',
    section: 'privacy',
    kind: 'toggle',
    default: false,
    effect: 'now',
    label: 'Intelligent Tracking Prevention',
    description:
      "WebKit's tracker blocking: it learns which sites track you across other sites and blocks their cookies. It can break some sign-in flows. While on, it replaces the third-party cookie rule below.",
  },
  {
    id: 'thirdPartyCookies',
    section: 'privacy',
    kind: 'choice',
    default: 'no-third-party',
    effect: 'now',
    label: 'Third-party cookies',
    description:
      'Cookies a page gets from another site than the one you are on (ads, embedded widgets). Blocking them stops most cross-site tracking. See the Cookies page for cookies one by one.',
    options: [
      { value: 'no-third-party', label: 'Block' },
      { value: 'always', label: 'Allow' },
    ],
  },
  {
    id: 'extensions',
    section: 'privacy',
    kind: 'toggle',
    default: false,
    effect: 'reload',
    label: 'Allow browser extensions (Chrome Web Store)',
    description:
      "Extensions can read and change every page they are allowed to run on, keep what they see and send it anywhere: by allowing them you accept being tracked by what you install. Installing one asks Google's servers for it. Off (the default), nothing about extensions runs and the Extensions page only explains this.",
  },
  {
    id: 'blockAutoplay',
    section: 'privacy',
    kind: 'toggle',
    default: false,
    effect: 'reload',
    label: 'Block autoplaying media',
    description: 'Video and audio start only after you click or press a key on the page.',
  },
  {
    id: 'webgl',
    section: 'pages',
    kind: 'toggle',
    default: true,
    effect: 'reload',
    label: 'WebGL',
    description:
      'Lets pages draw 3D graphics. Off also removes a way pages identify your graphics card.',
  },
  {
    id: 'bookmarksBarHomeOnly',
    section: 'pages',
    kind: 'toggle',
    default: false,
    effect: 'now',
    label: 'Only show the bookmarks bar on the home page',
    description:
      'The bar stays hidden everywhere else, even with bookmarks in it. Off (the default) shows it on every page, whenever there is at least one bookmark.',
  },
  {
    id: 'searchEngine',
    section: 'search',
    kind: 'choice',
    default: 'duckduckgo',
    effect: 'now',
    label: 'Search engine',
    description: 'Used when you type something in the address bar that is not an address.',
    options: [
      { value: 'duckduckgo', label: 'DuckDuckGo' },
      { value: 'brave', label: 'Brave Search' },
      { value: 'startpage', label: 'Startpage' },
      { value: 'ecosia', label: 'Ecosia' },
      { value: 'google', label: 'Google' },
      { value: 'bing', label: 'Bing' },
    ],
  },
  {
    id: 'downloadFolder',
    section: 'downloads',
    kind: 'text',
    default: '',
    effect: 'now',
    label: 'Download folder',
    description: 'A folder path. Empty uses your Downloads folder. Files are never overwritten.',
    placeholder: 'Downloads',
  },
] as const satisfies readonly SettingDefinition[];
