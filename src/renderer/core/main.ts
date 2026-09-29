import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/base.css';
import '../features/tab-bar/tab-bar.css';
import '../features/address-bar/address-bar.css';
import '../features/bookmarks/bookmarks.css';
import '../features/viewport/viewport.css';
import '../features/home/home.css';
import '../features/menu/menu.css';
import '../features/keybindings/keybindings.css';
import '../features/history/history.css';
import '../features/cookies/cookies.css';
import '../features/settings/settings.css';
import '../features/themes/themes.css';
import '../features/browsers/browsers.css';
import '../features/extensions/extensions.css';
import '../features/dev-settings/dev-settings.css';

import { createAddressBar } from '../features/address-bar/address-bar';
import { createBookmarkStar } from '../features/bookmarks/bookmark-star';
import { createBookmarksBar } from '../features/bookmarks/bookmarks-bar';
import { mountBookmarksPopup } from '../features/bookmarks/bookmarks-popup';
import { createExtensionButtons } from '../features/extensions/extension-buttons';
import { createStoreInstallButton } from '../features/extensions/store-install-button';
import { createMenuButton } from '../features/menu/menu-button';
import { mountMenuPanel } from '../features/menu/menu-panel';
import { createTabBar } from '../features/tab-bar/tab-bar';
import { createViewport } from '../features/viewport/viewport';
import { api } from './api-client';
import { initTheme } from './theme';
import { initUserCss } from './user-css';

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} in index.html`);
  return element;
}

async function initMenuView(): Promise<void> {
  document.getElementById('app')?.remove();
  mountMenuPanel(document.body, api);
  await initUserCss();
}

function initBookmarksPopupView(): void {
  document.getElementById('app')?.remove();
  mountBookmarksPopup(document.body, api);
}

async function initBrowserView(): Promise<void> {
  const chrome = requireElement('chrome');
  const addressBar = requireElement('address-bar');
  const views = [
    createTabBar(requireElement('tab-bar'), api),
    createAddressBar(addressBar, api),
    createBookmarkStar(addressBar, api),
    createViewport(requireElement('viewport'), api),
    createStoreInstallButton(addressBar, api),
  ];
  createBookmarksBar(requireElement('bookmarks-bar'), api);
  createExtensionButtons(addressBar, api);
  createMenuButton(addressBar, api);

  // The main process places the page views below the chrome, so it needs to know how tall it is.
  new ResizeObserver(() => {
    void api.tabs.setChromeHeight(chrome.getBoundingClientRect().height);
  }).observe(chrome);

  // The window buttons are drawn by the system over the end of the tab strip.
  api.ui.onWindowControls(({ width }) => {
    document.documentElement.style.setProperty('--window-controls-width', `${width}px`);
  });

  api.tabs.onStateChanged((state) => {
    for (const view of views) view.render(state);
  });
  const state = await api.tabs.getState();
  for (const view of views) view.render(state);

  await initUserCss();
}

// The theme comes before the user's CSS, which is appended later and so still wins.
initTheme(api);

// The same document is loaded for the browser UI, the transparent menu overlay, and the small
// bookmarks popover (the star's edit form, or a bookmarks-bar folder's contents).
const viewParam = new URLSearchParams(window.location.search).get('view');
const view = viewParam === 'menu' || viewParam === 'bookmarks-popup' ? viewParam : 'browser';
document.documentElement.dataset.view = view;
if (view === 'menu') void initMenuView();
else if (view === 'bookmarks-popup') initBookmarksPopupView();
else void initBrowserView();
