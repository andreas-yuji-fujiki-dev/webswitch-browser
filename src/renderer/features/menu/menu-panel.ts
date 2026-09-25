import { MENU_ITEMS } from '~shared/menu-items';
import type { BrowserApi } from '~types/browser-api';
import { el } from '../../core/dom';
import { icon } from '../../core/icons';

/**
 * The menu itself, rendered in its own overlay view. Icons only. Choosing an item asks the main
 * process to act on it; the user, updates and history items have no feature behind them yet.
 */
export function mountMenuPanel(root: HTMLElement, api: BrowserApi): void {
  const panel = el('div', 'menu-panel');
  panel.setAttribute('role', 'menu');

  let userButton: HTMLButtonElement | null = null;
  for (const item of MENU_ITEMS) {
    const button = el('button', 'menu-item');
    if (item.id === 'user') userButton = button;
    button.append(icon(item.icon));
    button.title = item.label;
    button.setAttribute('role', 'menuitem');
    button.setAttribute('aria-label', item.label);
    button.addEventListener('click', () => {
      void api.menu.select(item.id);
    });
    panel.append(button);
  }
  // The User item shows whether a Google account is signed in (read from local cookies).
  function showAccount(signedIn: boolean): void {
    if (!userButton) return;
    userButton.dataset.signedIn = String(signedIn);
    userButton.title = signedIn ? 'Google account' : 'Sign in with Google';
    userButton.setAttribute('aria-label', userButton.title);
  }
  showAccount(false);
  void api.account.get().then(({ signedIn }) => {
    showAccount(signedIn);
  });
  api.account.onChanged(({ signedIn }) => {
    showAccount(signedIn);
  });

  const wrapper = el('div', 'menu-root');
  wrapper.append(panel);
  root.append(wrapper);

  // The main process sizes the overlay to fit the panel.
  new ResizeObserver(() => {
    const { width, height } = panel.getBoundingClientRect();
    void api.menu.setSize(width, height);
  }).observe(panel);

  // The popover closes itself on any click outside; Escape closes it from the keyboard.
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') void api.menu.close();
  });
}
