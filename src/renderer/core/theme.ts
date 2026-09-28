import type { BrowserApi } from '~types/browser-api';

/**
 * The colors of the theme in use come as a stylesheet made by the main process
 * (webswitch://ui/theme.css), loaded after tokens.css and before user.css, so a theme overrides the
 * defaults and the user's own CSS still overrides the theme. It is loaded again when the theme changes.
 */
export function initTheme(api: BrowserApi): void {
  const link = document.createElement('link');
  link.id = 'ws-theme';
  link.rel = 'stylesheet';
  link.href = 'theme.css';
  document.head.append(link);
  api.themes.onChanged(() => {
    link.href = `theme.css?v=${String(Date.now())}`;
  });
}
