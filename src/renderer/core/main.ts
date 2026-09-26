import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/base.css';
import '../features/tab-bar/tab-bar.css';
import '../features/address-bar/address-bar.css';
import '../features/viewport/viewport.css';
import '../features/menu/menu.css';
import '../features/keybindings/keybindings.css';
import '../features/history/history.css';
import '../features/cookies/cookies.css';

import { createAddressBar } from '../features/address-bar/address-bar';
import { createMenuButton } from '../features/menu/menu-button';
import { mountMenuPanel } from '../features/menu/menu-panel';
import { createTabBar } from '../features/tab-bar/tab-bar';
import { createViewport } from '../features/viewport/viewport';
import { api } from './api-client';
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

async function initBrowserView(): Promise<void> {
  const chrome = requireElement('chrome');
  const addressBar = requireElement('address-bar');
  const views = [
    createTabBar(requireElement('tab-bar'), api),
    createAddressBar(addressBar, api),
    createViewport(requireElement('viewport'), api),
  ];
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

// The same document is loaded twice: as the browser UI and as the transparent menu overlay.
const view =
  new URLSearchParams(window.location.search).get('view') === 'menu' ? 'menu' : 'browser';
document.documentElement.dataset.view = view;
void (view === 'menu' ? initMenuView() : initBrowserView());
