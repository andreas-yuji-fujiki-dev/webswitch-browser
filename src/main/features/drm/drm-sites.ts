/**
 * Sites that need DRM (Widevine), which WebKitGTK does not have. A page on one of these hosts (or
 * their subdomains) opens in Chromium instead. Matching is by host suffix; a leading "=" matches
 * that exact host only (spotify.com, but not accounts.spotify.com, which other sites use to sign in).
 */
export const DRM_HOSTS: readonly string[] = [
  'netflix.com',
  '=spotify.com',
  'www.spotify.com',
  'open.spotify.com',
  'play.spotify.com',
  'disneyplus.com',
  'primevideo.com',
  'max.com',
  'hbomax.com',
  'hulu.com',
  'crunchyroll.com',
  'tv.apple.com',
  'paramountplus.com',
  'peacocktv.com',
];

/** Chromium-family browsers that ship Widevine, best first. Chromium itself usually does not. */
export const DRM_BROWSERS: readonly { command: string; name: string }[] = [
  { command: 'google-chrome-stable', name: 'Google Chrome' },
  { command: 'google-chrome', name: 'Google Chrome' },
  { command: 'microsoft-edge-stable', name: 'Microsoft Edge' },
  { command: 'brave-browser', name: 'Brave' },
  { command: 'vivaldi', name: 'Vivaldi' },
  { command: 'chromium', name: 'Chromium' },
  { command: 'chromium-browser', name: 'Chromium' },
];
