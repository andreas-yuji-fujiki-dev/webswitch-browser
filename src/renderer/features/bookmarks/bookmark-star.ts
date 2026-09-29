import type { BookmarksState } from '~types/bookmarks';
import type { BrowserApi } from '~types/browser-api';
import type { TabState } from '~types/tabs';
import type { StateView } from '~types/ui';
import { el } from '../../core/dom';
import { icon } from '../../core/icons';

/**
 * The star button in the address bar: filled while the current page is bookmarked, empty
 * otherwise. Clicking an empty star bookmarks the page to the bar's own top level right away
 * (like Chrome) and opens the edit popover so the user can move it into a folder or rename it;
 * clicking a filled star reopens that same popover on the existing bookmark.
 */
export function createBookmarkStar(container: HTMLElement, api: BrowserApi): StateView {
  const button = el('button', 'nav-button bookmark-star');
  const star = icon('star');
  button.append(star);
  container.append(button);

  let active: TabState | undefined;
  let state: BookmarksState = { folders: [], bookmarks: [] };

  const bookmarked = (): boolean =>
    active !== undefined && state.bookmarks.some((bookmark) => bookmark.url === active?.url);

  const refresh = (): void => {
    const on = bookmarked();
    star.classList.toggle('icon--filled', on);
    button.classList.toggle('is-active', on);
    button.title = on ? 'Edit this bookmark' : 'Bookmark this page (Ctrl+D)';
    button.setAttribute('aria-label', button.title);
  };

  const openEditPopup = (): void => {
    const box = button.getBoundingClientRect();
    void api.bookmarks.openPopup(
      'star',
      null,
      Math.round(box.left),
      Math.round(box.top),
      Math.round(box.width),
      Math.round(box.height),
    );
  };

  button.addEventListener('click', () => {
    if (!active) return;
    if (bookmarked()) {
      openEditPopup();
    } else {
      void api.bookmarks.add(active.url, active.title || active.url, null).then(openEditPopup);
    }
  });

  api.bookmarks.onChanged((next) => {
    state = next;
    refresh();
  });
  api.bookmarks.onShortcut(() => {
    if (!button.hidden) button.click();
  });
  void api.bookmarks.get().then((initial) => {
    state = initial;
    refresh();
  });

  return {
    render(tabsState) {
      active = tabsState.tabs.find((tab) => tab.id === tabsState.activeTabId);
      button.hidden = active?.page !== null || !/^https?:/.test(active.url);
      refresh();
    },
  };
}
