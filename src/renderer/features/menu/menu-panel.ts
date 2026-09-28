import { MENU_ITEMS } from '~shared/menu-items';
import type { BrowserApi } from '~types/browser-api';
import type { BrowsersState } from '~types/browsers';
import type { CookiesSummary } from '~types/cookies';
import { el } from '../../core/dom';
import { icon } from '../../core/icons';

/**
 * The menu panel: it takes the right half of the window, rendered in its own web view. Each item
 * shows its icon and its name. Choosing an item asks the main process to act on it; the switch and
 * updates items have no feature behind them yet.
 */
export function mountMenuPanel(root: HTMLElement, api: BrowserApi): void {
  const wrapper = el('div', 'menu-root');

  const header = el('header', 'menu-header');
  const close = el('button', 'menu-close');
  close.append(icon('close'));
  close.title = 'Close the menu (Esc)';
  close.setAttribute('aria-label', 'Close the menu');
  close.addEventListener('click', () => {
    void api.menu.close();
  });
  header.append(el('h2', 'menu-title', 'Switches'), close);

  const panel = el('nav', 'menu-panel');
  panel.setAttribute('role', 'menu');
  // Items of the same group share a box; a border above every box but the first separates them.
  const groups = new Map<string, HTMLElement>();

  let userButton: HTMLButtonElement | null = null;
  let userDetail: HTMLElement | null = null;
  for (const item of MENU_ITEMS) {
    // The gear of the row of browsers is not a list row.
    if (item.group === 'testing') continue;
    const button = el('button', 'menu-item');
    const text = el('span', 'menu-text');
    text.append(el('span', 'menu-label', item.label));
    if (item.id === 'user') {
      // The state of the cookies sits under the title, not inside it.
      userButton = button;
      userDetail = el('span', 'menu-detail');
      text.append(userDetail);
    }
    button.append(icon(item.icon), text);
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => {
      void api.menu.select(item.id);
    });
    let group = groups.get(item.group);
    if (!group) {
      group = el('div', 'menu-group');
      groups.set(item.group, group);
      panel.append(group);
    }
    group.append(button);
  }
  // "Signed in: Google, GitHub · All cookies: 148": read from the cookie jar each time the menu opens
  // and whenever the cookies change while it is open.
  function showCookies(summary: CookiesSummary | null): void {
    if (!userButton || !userDetail) return;
    userButton.dataset.signedIn = String(summary !== null && summary.signedIn.length > 0);
    userDetail.hidden = summary === null;
    if (summary === null) return;
    const who = summary.signedIn.length > 0 ? summary.signedIn.join(', ') : 'nobody';
    userDetail.textContent = `Signed in: ${who} · All cookies: ${summary.total}`;
    userDetail.title = userDetail.textContent;
  }
  showCookies(null);
  function refreshCookies(): void {
    void api.cookies.summary().then(showCookies);
  }
  refreshCookies();
  api.cookies.onChanged(refreshCookies);
  api.menu.onStateChanged(({ open }) => {
    if (open) refreshCookies();
  });

  // A row of browsers to open the current page in, and the gear that manages them.
  const testing = el('div', 'menu-group menu-testing');
  testing.append(el('p', 'menu-testing__title', 'Test in other browsers'));
  const row = el('div', 'menu-testing__row');
  const browserButtons = new Map<string, HTMLButtonElement>();
  const engines = [
    ['chrome', 'Chrome', 'chrome'],
    ['firefox', 'Firefox', 'firefox'],
    ['opera', 'Opera', 'opera'],
    ['edge', 'Edge', 'edge'],
    ['webkit', 'Safari (WebKit)', 'safari'],
  ] as const;
  for (const [id, name, iconName] of engines) {
    const button = el('button', 'menu-browser');
    button.append(icon(iconName));
    button.setAttribute('aria-label', name);
    button.title = name;
    button.addEventListener('click', () => {
      void api.browsers.open(id);
    });
    browserButtons.set(id, button);
    row.append(button);
  }
  const manage = el('button', 'menu-browser menu-browser--gear');
  manage.append(icon('gear'));
  manage.title = 'Install, update and remove the browsers to test in';
  manage.setAttribute('aria-label', 'Manage the browsers to test in');
  manage.addEventListener('click', () => {
    void api.menu.select('browsers');
  });
  row.append(manage);
  testing.append(row);
  panel.append(testing);

  // What is installed decides how each one is drawn: an installed browser opens the page at once,
  // one that is not takes you to where it is installed.
  function showBrowsers(state: BrowsersState): void {
    for (const [id, name] of engines.map(([engine, label]) => [engine, label] as const)) {
      const button = browserButtons.get(id);
      const status = state.browsers.find((browser) => browser.id === id);
      if (!button) continue;
      const installed = id === 'webkit' || (status?.installed.length ?? 0) > 0;
      button.dataset.installed = String(installed);
      const version = status?.installed.find((release) => release.active)?.version;
      button.title =
        id === 'webkit'
          ? `${name}: this page in a new tab (Webswitch's own engine, the same family as Safari's)`
          : installed
            ? `Open this page in ${name}${version ? ` ${version}` : ''}, inside a tab`
            : `${name} is not installed: click to install it`;
    }
  }
  function refreshBrowsers(): void {
    void api.browsers.get().then(showBrowsers);
  }
  refreshBrowsers();
  api.browsers.onChanged(showBrowsers);
  api.menu.onStateChanged(({ open }) => {
    if (open) refreshBrowsers();
  });

  wrapper.append(header, panel);
  root.append(wrapper);

  // Escape closes the panel from the keyboard (it holds the keyboard focus while it is open).
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') void api.menu.close();
  });
}
