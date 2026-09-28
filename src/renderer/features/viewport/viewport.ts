import type { BrowserApi } from '~types/browser-api';
import type { InternalPage } from '~types/tabs';
import type { BuiltInPage, StateView } from '~types/ui';
import { el } from '../../core/dom';
import { createCookiesPage } from '../cookies/cookies-page';
import { createDevSettingsPage } from '../dev-settings/dev-settings-page';
import { createHistoryPage } from '../history/history-page';
import { createHome } from '../home/home';
import { createKeybindingsPage } from '../keybindings/keybindings-page';
import { createBrowsersPage } from '../browsers/browsers-page';
import { createExtensionsPage } from '../extensions/extensions-page';
import { createThemesPage } from '../themes/themes-page';
import { createSettingsPage } from '../settings/settings-page';
import httpcat400 from './httpcat/400.jpg';
import httpcat401 from './httpcat/401.jpg';
import httpcat403 from './httpcat/403.jpg';
import httpcat404 from './httpcat/404.jpg';
import httpcat408 from './httpcat/408.jpg';
import httpcat429 from './httpcat/429.jpg';
import httpcat500 from './httpcat/500.jpg';
import httpcat502 from './httpcat/502.jpg';
import httpcat503 from './httpcat/503.jpg';
import httpcat504 from './httpcat/504.jpg';

// Only a handful of common statuses have their own picture, from https://http.cat (fair use,
// credited by the "see more" button). Bundling one for every status there could be (never mind a
// network-level failure, which has no HTTP status at all, only WebKit's own numeric error code)
// would mean an image, or a wrong one, for codes that barely happen — so anything not listed here
// gets a plain, large number instead (see `load-error__number` below), which costs nothing to add
// and reads fine either way.
const HTTPCAT: Record<number, string> = {
  400: httpcat400,
  401: httpcat401,
  403: httpcat403,
  404: httpcat404,
  408: httpcat408,
  429: httpcat429,
  500: httpcat500,
  502: httpcat502,
  503: httpcat503,
  504: httpcat504,
};

/**
 * What shows in the page area when there is no web page: a blank tab (the wordmark), a load
 * error, or a built-in page such as Keybindings or History.
 */
export function createViewport(container: HTMLElement, api: BrowserApi): StateView {
  const factories: Record<InternalPage, () => BuiltInPage> = {
    keybindings: () => createKeybindingsPage(api),
    history: () => createHistoryPage(api),
    cookies: () => createCookiesPage(api),
    settings: () => createSettingsPage(api),
    themes: () => createThemesPage(api),
    browsers: () => createBrowsersPage(api),
    extensions: () => createExtensionsPage(api),
    'dev-settings': () => createDevSettingsPage(api),
  };
  // The home page keeps what was typed and the keyboard focus across state events.
  const home = createHome(api);
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
      const onHome = !active?.error && active?.url === '';
      // The home page stays in place across state events, so typing in it is not interrupted.
      if (onHome) {
        if (container.firstElementChild !== home.root || container.childElementCount !== 1) {
          container.replaceChildren(home.root);
        }
        requestAnimationFrame(home.focus);
        return;
      }
      container.replaceChildren();

      if (active?.error) {
        const { error } = active;
        const box = el('div', 'load-error');
        const status = error.httpStatus;
        const image = status !== undefined ? HTTPCAT[status] : undefined;
        if (image !== undefined) {
          // The bundled picture already reads e.g. "404 Not Found" on its own; the text below
          // would only repeat it.
          const cat = el('img', 'load-error__cat');
          cat.src = image;
          cat.alt = `HTTP ${String(status)}`;
          box.append(cat);
        } else {
          // No picture for this one — an HTTP status outside the small bundled set, or a
          // network-level failure (no HTTP status at all, only WebKit's own numeric error code).
          // Costs nothing to show it big regardless of which one it is.
          box.append(el('p', 'load-error__number', String(status ?? error.code)));
          box.append(
            el('p', 'load-error__title', `Can't load ${active.url}`),
            el(
              'p',
              'load-error__detail',
              status !== undefined
                ? error.description
                : `${error.description} (code ${String(error.code)})`,
            ),
          );
        }
        if (status !== undefined) {
          // A plain <a> would go nowhere: the UI view refuses every navigation off webswitch://ui/
          // (see core/webviews.ts's createUiView), the same reason cookies-page.ts's account-panel
          // links are buttons that ask the native side to open a tab, not anchors. Only an HTTP
          // status has an MDN page to send it to — a network-level failure's `code` is WebKit's own
          // internal error number, not documented anywhere public to link to.
          const more = el('button', 'load-error__more', `See more about ${String(status)}`);
          more.addEventListener('click', () => {
            void api.tabs.openHttpStatus(status);
          });
          box.append(more);
        }
        container.append(box);
      }
    },
  };
}
