import type { BrowserApi } from '~types/browser-api';
import { el } from '../../core/dom';
import { icon } from '../../core/icons';

/** The "⋮" button at the right end of the toolbar. It only asks the main process to toggle the menu. */
export function createMenuButton(container: HTMLElement, api: BrowserApi): void {
  const button = el('button', 'nav-button menu-button');
  button.append(icon('more'));
  button.title = 'Menu';
  button.setAttribute('aria-label', 'Menu');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  container.append(button);

  button.addEventListener('click', () => {
    const { right, bottom } = button.getBoundingClientRect();
    void api.menu.toggle(Math.round(right), Math.round(bottom));
  });
  api.menu.onStateChanged(({ open }) => {
    button.setAttribute('aria-expanded', String(open));
    button.dataset.open = String(open);
  });
}
