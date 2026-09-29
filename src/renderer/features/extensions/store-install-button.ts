import type { BrowserApi } from '~types/browser-api';
import type { StateView } from '~types/ui';
import { el } from '../../core/dom';

/**
 * Shown in the toolbar only while the active tab is on one extension's own page on the real Chrome
 * Web Store (`Tab.storeId`, set by the native side from the address — see `shared/crx.ts`'s
 * `webStoreDetailId`): installs it directly through Webswitch's own flow (download, then the usual
 * confirmation card on the Extensions page), since the store's own "Add to Chrome" button has
 * nothing to talk to in a non-Chrome browser and would otherwise just do nothing when clicked.
 */
export function createStoreInstallButton(container: HTMLElement, api: BrowserApi): StateView {
  const button = el('button', 'store-install', 'Install in Webswitch');
  button.hidden = true;
  container.append(button);
  let storeId: string | null = null;

  button.addEventListener('click', () => {
    if (storeId === null || button.disabled) return;
    const id = storeId;
    button.disabled = true;
    button.textContent = 'Installing…';
    void api.extensions
      .prepareStore(id)
      .then(() => api.menu.select('extensions'))
      .finally(() => {
        button.disabled = false;
        button.textContent = 'Install in Webswitch';
      });
  });

  return {
    render(state) {
      const active = state.tabs.find((tab) => tab.id === state.activeTabId);
      storeId = active?.storeId ?? null;
      button.hidden = storeId === null;
    },
  };
}
