import type { BrowserApi } from '~types/browser-api';
import type { TabState } from '~types/tabs';
import type { StateView } from '~types/ui';
import { el } from '../../core/dom';
import { icon } from '../../core/icons';

export function createTabBar(container: HTMLElement, api: BrowserApi): StateView {
  const list = el('div', 'tab-list');
  list.setAttribute('role', 'tablist');
  const newTab = el('button', 'tab-new');
  newTab.append(icon('plus'));
  newTab.title = 'New tab (Ctrl+T)';
  newTab.setAttribute('aria-label', 'New tab');
  newTab.addEventListener('click', () => {
    void api.tabs.create();
  });
  container.append(list, newTab);

  // The window has no title bar: empty space in the strip, after the last tab and the "+" button,
  // moves the window. The native side needs to know where that space starts.
  const reportTitleBarLayout = (): void => {
    void api.ui.setTitleBarLayout(
      Math.ceil(newTab.getBoundingClientRect().right),
      Math.ceil(container.getBoundingClientRect().height),
    );
  };
  const layoutObserver = new ResizeObserver(reportTitleBarLayout);
  layoutObserver.observe(container);
  layoutObserver.observe(list);

  // Elements are reused between renders so a click is never lost to a re-render mid-gesture.
  const items = new Map<number, { root: HTMLElement; title: HTMLElement }>();

  function createItem(id: number): { root: HTMLElement; title: HTMLElement } {
    const root = el('div', 'tab');
    root.setAttribute('role', 'tab');
    const title = el('span', 'tab__title');
    const close = el('button', 'tab__close');
    close.append(icon('close'));
    close.title = 'Close tab (Ctrl+W)';
    close.setAttribute('aria-label', 'Close tab');
    root.append(title, close);

    root.addEventListener('click', () => {
      void api.tabs.activate(id);
    });
    root.addEventListener('mousedown', (event) => {
      if (event.button === 1) event.preventDefault();
    });
    root.addEventListener('auxclick', (event) => {
      if (event.button === 1) void api.tabs.close(id);
    });
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      void api.tabs.close(id);
    });
    return { root, title };
  }

  function label(tab: TabState): string {
    return tab.title || tab.url || 'New tab';
  }

  return {
    render(state) {
      const live = new Set(state.tabs.map((tab) => tab.id));
      for (const [id, item] of items) {
        if (!live.has(id)) {
          item.root.remove();
          items.delete(id);
        }
      }

      state.tabs.forEach((tab, index) => {
        let item = items.get(tab.id);
        if (!item) {
          item = createItem(tab.id);
          items.set(tab.id, item);
        }
        item.root.dataset.active = String(tab.id === state.activeTabId);
        item.root.dataset.loading = String(tab.loading);
        item.root.setAttribute('aria-selected', String(tab.id === state.activeTabId));
        item.root.title = label(tab);
        item.title.textContent = label(tab);
        if (list.children[index] !== item.root) {
          list.insertBefore(item.root, list.children[index] ?? null);
        }
      });
      reportTitleBarLayout();
    },
  };
}
