import type { BrowserApi } from '~types/browser-api';
import type { InternalPage } from '~types/tabs';
import type { BuiltInPage, StateView } from '~types/ui';
import { el } from '../../core/dom';
import { createCookiesPage } from '../cookies/cookies-page';
import { createHistoryPage } from '../history/history-page';
import { createKeybindingsPage } from '../keybindings/keybindings-page';

/**
 * What shows in the page area when there is no web page: a blank tab (the wordmark), a load
 * error, or a built-in page such as Keybindings or History.
 */
export function createViewport(container: HTMLElement, api: BrowserApi): StateView {
  const factories: Record<InternalPage, () => BuiltInPage> = {
    keybindings: () => createKeybindingsPage(api),
    history: () => createHistoryPage(api),
    cookies: () => createCookiesPage(api),
  };
  // Pages are built once and kept, so an edit in progress survives every state event.
  const pages: Partial<Record<InternalPage, BuiltInPage>> = {};
  let shown: InternalPage | null = null;

  return {
    render(state) {
      const active = state.tabs.find((tab) => tab.id === state.activeTabId);

      if (active?.page) {
        container.dataset.mode = 'page';
        const page = (pages[active.page] ??= factories[active.page]());
        if (shown !== active.page) {
          if (shown) pages[shown]?.hide();
          container.replaceChildren(page.root);
          shown = active.page;
          page.show();
        }
        return;
      }

      if (shown) pages[shown]?.hide();
      shown = null;
      container.dataset.mode = '';
      container.replaceChildren();

      if (active?.error) {
        const box = el('div', 'load-error');
        box.append(
          el('p', 'load-error__title', `Can't load ${active.url}`),
          el('p', 'load-error__detail', active.error.description),
        );
        container.append(box);
      } else if (active?.url === '') {
        const wordmark = el('p', 'wordmark');
        wordmark.append(el('span', 'wordmark__dim', '.web'), 'switch');
        container.append(wordmark);
      }
    },
  };
}
