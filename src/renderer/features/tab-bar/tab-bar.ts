import type { BrowserApi } from '~types/browser-api';
import type { TabState } from '~types/tabs';
import type { StateView } from '~types/ui';
import { el } from '../../core/dom';
import { icon } from '../../core/icons';

/** Below this many CSS pixels of pointer movement, a press-and-release is a click, not a drag. */
const DRAG_THRESHOLD = 6;

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
  const items = new Map<
    number,
    { root: HTMLElement; title: HTMLElement; pin: HTMLElement; mute: HTMLElement }
  >();

  // Pointer-driven drag-and-drop reordering, the same design as the bookmarks bar's
  // (`bookmarks-bar.ts`): `pointerdown`/`pointermove`/`pointerup`/`setPointerCapture` and a distance
  // threshold instead of native HTML5 drag-and-drop, which was found unreliable enough on WebKitGTK
  // to make plain clicking flaky once `draggable` was merely turned on. `suppressClick` is a plain
  // closure flag each tab's own (single, permanently registered) click handler checks and clears at
  // its own top -- not a second listener added from inside `pointerup`, which per the DOM spec would
  // run *after* the click handler `createItem` already registered and could never stop it in time
  // (the exact bug the bookmarks bar hit first; see CLAUDE.md's `bookmarks` entry).
  let currentOrder: number[] = [];
  let down: { id: number; x: number; y: number; started: boolean } | null = null;
  let dropTarget: HTMLElement | null = null;
  let suppressClick = false;

  function clearDropTarget(): void {
    dropTarget?.classList.remove('is-drop-target');
    dropTarget = null;
  }

  function endDrag(root: HTMLElement, event: PointerEvent): void {
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    root.classList.remove('is-dragging');
    clearDropTarget();
    down = null;
  }

  function createItem(id: number): {
    root: HTMLElement;
    title: HTMLElement;
    pin: HTMLElement;
    mute: HTMLElement;
  } {
    const root = el('div', 'tab');
    root.setAttribute('role', 'tab');

    const pin = el('button', 'tab__pin');
    pin.append(icon('pin'));

    const title = el('span', 'tab__title');

    const mute = el('button', 'tab__mute');
    mute.append(icon('volume'));

    const close = el('button', 'tab__close');
    close.append(icon('close'));
    close.title = 'Close tab (Ctrl+W)';
    close.setAttribute('aria-label', 'Close tab');

    root.append(pin, title, mute, close);

    root.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      down = { id, x: event.clientX, y: event.clientY, started: false };
      root.setPointerCapture(event.pointerId);
    });
    root.addEventListener('pointermove', (event) => {
      if (down?.id !== id) return;
      if (!down.started) {
        const dx = event.clientX - down.x;
        const dy = event.clientY - down.y;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        down.started = true;
        root.classList.add('is-dragging');
      }
      const under = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('.tab');
      if (under !== dropTarget) {
        clearDropTarget();
        if (under && under !== root) {
          under.classList.add('is-drop-target');
          dropTarget = under;
        }
      }
    });
    root.addEventListener('pointerup', (event) => {
      if (down?.id !== id) return;
      const target = dropTarget;
      const wasDrag = down.started;
      endDrag(root, event);
      if (!wasDrag || !target) return;
      // A real drag: the click this same press-and-release would otherwise still fire is not
      // wanted (it would activate the tab right after moving it). The click handler below checks
      // this and bails out, the first time it runs.
      suppressClick = true;
      const targetId = Number(target.dataset.tabId);
      const order = [...currentOrder];
      const fromIndex = order.indexOf(id);
      const toIndex = order.indexOf(targetId);
      if (fromIndex === -1 || toIndex === -1) return;
      const [moved] = order.splice(fromIndex, 1);
      if (moved !== undefined) order.splice(toIndex, 0, moved);
      void api.tabs.reorder(order);
    });
    root.addEventListener('pointercancel', (event) => {
      if (down?.id !== id) return;
      endDrag(root, event);
    });

    root.addEventListener('click', () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      void api.tabs.activate(id);
    });
    root.addEventListener('mousedown', (event) => {
      if (event.button === 1) event.preventDefault();
    });
    root.addEventListener('auxclick', (event) => {
      if (event.button === 1) void api.tabs.close(id);
    });
    pin.addEventListener('click', (event) => {
      event.stopPropagation();
      void api.tabs.setPinned(id, root.dataset.pinned !== 'true');
    });
    mute.addEventListener('click', (event) => {
      event.stopPropagation();
      void api.tabs.setMuted(id, root.dataset.muted !== 'true');
    });
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      void api.tabs.close(id);
    });
    return { root, title, pin, mute };
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

      currentOrder = state.tabs.map((tab) => tab.id);
      state.tabs.forEach((tab, index) => {
        let item = items.get(tab.id);
        if (!item) {
          item = createItem(tab.id);
          items.set(tab.id, item);
        }
        const { root, title, pin, mute } = item;
        root.dataset.tabId = String(tab.id);
        root.dataset.active = String(tab.id === state.activeTabId);
        root.dataset.loading = String(tab.loading);
        root.dataset.pinned = String(tab.pinned);
        root.dataset.muted = String(tab.muted);
        // The mute control only shows while it says something -- audible right now, or already
        // muted -- the same rule Chrome uses, not on every tab.
        root.dataset.audible = String(tab.playingAudio || tab.muted);
        root.setAttribute('aria-selected', String(tab.id === state.activeTabId));
        root.title = label(tab);
        pin.setAttribute('aria-pressed', String(tab.pinned));
        pin.setAttribute('aria-label', tab.pinned ? 'Unpin tab' : 'Pin tab');
        pin.title = tab.pinned ? 'Unpin tab' : 'Pin tab';
        mute.setAttribute('aria-pressed', String(tab.muted));
        mute.setAttribute('aria-label', tab.muted ? 'Unmute tab' : 'Mute tab');
        mute.title = tab.muted ? 'Unmute tab' : 'Mute tab';
        // Two distinct icon glyphs (not one CSS-toggled shape): the mute state flips which one is
        // in the DOM, cheap enough for a handful of tabs and simpler than redrawing a path.
        if (mute.dataset.icon !== String(tab.muted)) {
          mute.dataset.icon = String(tab.muted);
          mute.replaceChildren(icon(tab.muted ? 'muted' : 'volume'));
        }
        title.textContent = label(tab);
        if (list.children[index] !== root) {
          list.insertBefore(root, list.children[index] ?? null);
        }
      });
      reportTitleBarLayout();
    },
  };
}
