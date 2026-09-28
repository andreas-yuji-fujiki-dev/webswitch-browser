import type { BrowserApi } from '~types/browser-api';
import type { ExtensionsState } from '~types/extensions';
import { el } from '../../core/dom';

/**
 * One button per extension that has an action, between the address bar and the menu button. The
 * badge is the text the extension put over its icon. Clicking opens the extension's popup under the
 * button (the main process draws it) or, when it has none, tells the extension it was clicked.
 */
export function createExtensionButtons(container: HTMLElement, api: BrowserApi): void {
  const proxy = el('span', 'ext-proxy', 'Proxy');
  proxy.hidden = true;
  const row = el('div', 'ext-buttons');
  row.hidden = true;
  container.append(proxy, row);

  function render(state: ExtensionsState): void {
    // Never a surprise: while an extension routes the pages through a proxy, the toolbar says so.
    proxy.hidden = !(state.enabled && state.proxy);
    proxy.title = state.proxy ? `${state.proxy.name}: ${state.proxy.description}` : '';
    const shown = state.enabled
      ? state.extensions.filter((extension) => extension.enabled && extension.hasAction)
      : [];
    row.hidden = shown.length === 0;
    row.replaceChildren(
      ...shown.map((extension) => {
        const button = el('button', 'ext-button');
        button.title = extension.title === '' ? extension.name : extension.title;
        button.setAttribute('aria-label', extension.name);
        const picture = extension.actionIcon ?? extension.icon;
        if (picture !== null) {
          const image = el('img', 'ext-button__icon');
          image.src = picture;
          image.alt = '';
          button.append(image);
        } else {
          button.append(el('span', 'ext-button__letter', extension.name.slice(0, 1).toUpperCase()));
        }
        if (extension.badge !== '') {
          const badge = el('span', 'ext-button__badge', extension.badge);
          if (extension.badgeColor !== '') badge.style.background = extension.badgeColor;
          button.append(badge);
        }
        button.addEventListener('click', () => {
          const box = button.getBoundingClientRect();
          void api.extensions.openPopup(
            extension.id,
            Math.round(box.left),
            Math.round(box.top),
            Math.round(box.width),
            Math.round(box.height),
          );
        });
        return button;
      }),
    );
  }

  api.extensions.onChanged(render);
  void api.extensions.get().then(render);
}
