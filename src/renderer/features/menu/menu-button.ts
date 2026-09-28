import type { BrowserApi } from '~types/browser-api';
import { el } from '../../core/dom';
import { icon } from '../../core/icons';

/**
 * The "⋮" button at the right end of the toolbar. It only asks the main process to toggle the menu
 * panel; while the panel is open the page area of this UI makes room for it (see menu.css).
 */
export function createMenuButton(container: HTMLElement, api: BrowserApi): void {
  const button = el('button', 'nav-button menu-button');
  button.append(icon('more'));
  button.title = 'Menu';
  button.setAttribute('aria-label', 'Menu');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  container.append(button);

  button.addEventListener('click', () => {
    void api.menu.toggle();
  });
  api.menu.onStateChanged(({ open, fraction }) => {
    button.setAttribute('aria-expanded', String(open));
    button.dataset.open = String(open);
    document.body.dataset.menuOpen = String(open);
    document.body.style.setProperty('--menu-panel-width', `${(fraction * 100).toFixed(3)}vw`);
  });
}
