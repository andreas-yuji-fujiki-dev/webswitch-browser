import type { BookmarkBarEntry, BookmarkOrderEntry, BookmarksState } from '~types/bookmarks';
import type { BrowserApi } from '~types/browser-api';
import { el } from '../../core/dom';
import { icon } from '../../core/icons';

/** Below this many CSS pixels of pointer movement, a press-and-release is a click, not a drag. */
const DRAG_THRESHOLD = 6;

/**
 * The bar under the address bar, Chrome-style: top-level bookmarks and folders, in drag order. A
 * bookmark navigates the current tab; a folder opens a popover with its own contents (left click)
 * or a rename/delete popover (right click, `kind: 'folder-menu'`); a bookmark's right click opens
 * the same edit popover the star uses, on that specific bookmark (`kind: 'bookmark'`). Right-click
 * on the bar's own empty space (not an item) opens a small menu to add a bookmark or a folder by
 * hand (`kind: 'add-menu'`). Dragging an item onto another reorders the bar
 * (`bookmarks.reorderBar`, see `bookmarks.service.ts`) -- with the Pointer Events API and a
 * distance threshold, not the browser's native HTML5 drag-and-drop: that needs `dataTransfer`,
 * `preventDefault()` on every `dragover` to even allow a drop, a `dropEffect` for the right cursor,
 * and still leaves the drag/click distinction to each engine's own heuristics for how much a press
 * may move before it stops being a click -- unreliable enough in WebKitGTK specifically (confirmed
 * by hand: clicking a bookmark to navigate became flaky once `draggable` was on) that it was
 * dropped for a small, fully self-controlled implementation instead. Hidden entirely while there
 * is nothing in it, so it costs no space (and no chrome height, which the main process measures
 * live) until the first bookmark is added, and also while the "Only show the bookmarks bar on the
 * home page" setting is on and the current tab is not the home page (`url === ''`). Driven by its
 * own `bookmarks:changed` and `settings:changed` events, not by the tabs state the way most views
 * here are, so unlike them it is not part of the `views` array `main.ts` redraws on every tab
 * change -- it keeps its own small subscription to `tabs:state-changed` instead, only for the one
 * thing it needs from it.
 */
export function createBookmarksBar(container: HTMLElement, api: BrowserApi): void {
  let state: BookmarksState = { folders: [], bookmarks: [] };
  let homeOnly = false;
  let onHomePage = true;

  function entries(): BookmarkBarEntry[] {
    return [
      ...state.folders
        .filter((folder) => folder.parentId === null)
        .map((item): BookmarkBarEntry => ({ kind: 'folder', item })),
      ...state.bookmarks
        .filter((bookmark) => bookmark.folderId === null)
        .map((item): BookmarkBarEntry => ({ kind: 'bookmark', item })),
    ].sort((a, b) => a.item.order - b.item.order);
  }

  function openPopupAt(
    kind: 'star' | 'bookmark' | 'folder' | 'folder-menu' | 'add-menu',
    id: string | null,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    void api.bookmarks.openPopup(kind, id, rect.x, rect.y, rect.width, rect.height);
  }

  function openPopupFor(
    button: HTMLElement,
    kind: 'star' | 'bookmark' | 'folder' | 'folder-menu',
    id: string | null,
  ): void {
    const box = button.getBoundingClientRect();
    openPopupAt(kind, id, {
      x: Math.round(box.left),
      y: Math.round(box.top),
      width: Math.round(box.width),
      height: Math.round(box.height),
    });
  }

  // Pointer-driven drag-and-drop, entirely local to this closure: `down` is set on pointerdown
  // and cleared on pointerup/cancel; `started` flips to true only past DRAG_THRESHOLD. Real
  // hardware input still has the browser fire a `click` after the pointerdown/up pair once
  // `started`, and each entry's own click handler below checks `suppressClick` and bails out
  // first, rather than trying to intercept that click with a second, dynamically added listener:
  // per the DOM spec, listeners on the very element being dispatched to run in the order they
  // were *added*, regardless of the capture flag, so a listener added here, during pointerup,
  // would run *after* the click handler `draw()` already added for the button earlier and could
  // not stop it in time (a first version of this code tried exactly that, and a self-test
  // dispatching a real trailing `click` after the drag caught it: the folder popup opened
  // anyway, right after the item it belonged to had just been dragged elsewhere).
  let down: { id: string; x: number; y: number; started: boolean } | null = null;
  let dropTarget: HTMLElement | null = null;
  let suppressClick = false;

  function clearDropTarget(): void {
    dropTarget?.classList.remove('is-drop-target');
    dropTarget = null;
  }

  function endDrag(button: HTMLElement, event: PointerEvent): void {
    if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
    button.classList.remove('is-dragging');
    clearDropTarget();
    down = null;
  }

  function draw(): void {
    container.replaceChildren();
    const current = entries();
    container.hidden = current.length === 0 || (homeOnly && !onHomePage);
    for (const entry of current) {
      const button = el('button', 'bookmark-item');
      const glyph = icon(entry.kind === 'folder' ? 'folder' : 'star');
      glyph.classList.add('icon--filled', `bookmark-item__icon--${entry.kind}`);
      button.append(glyph, el('span', 'bookmark-item__label', entry.item.title));
      button.dataset.bmId = entry.item.id;

      button.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        down = { id: entry.item.id, x: event.clientX, y: event.clientY, started: false };
        button.setPointerCapture(event.pointerId);
      });
      button.addEventListener('pointermove', (event) => {
        if (down?.id !== entry.item.id) return;
        if (!down.started) {
          const dx = event.clientX - down.x;
          const dy = event.clientY - down.y;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          down.started = true;
          button.classList.add('is-dragging');
        }
        const under = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>('.bookmark-item');
        if (under !== dropTarget) {
          clearDropTarget();
          if (under && under !== button) {
            under.classList.add('is-drop-target');
            dropTarget = under;
          }
        }
      });
      button.addEventListener('pointerup', (event) => {
        if (down?.id !== entry.item.id) return;
        const target = dropTarget;
        const wasDrag = down.started;
        endDrag(button, event);
        if (!wasDrag || !target) return;
        // A real drag: the click this same press-and-release would otherwise still fire is not
        // wanted (it would navigate a bookmark or open a folder right after moving it). Each
        // entry's own click handler below checks this and bails out, the first time it runs.
        suppressClick = true;
        const targetId = target.dataset.bmId;
        const newOrder = entries().map((item): BookmarkOrderEntry => ({
          kind: item.kind,
          id: item.item.id,
        }));
        const fromIndex = newOrder.findIndex((item) => item.id === entry.item.id);
        const toIndex = newOrder.findIndex((item) => item.id === targetId);
        if (fromIndex === -1 || toIndex === -1) return;
        const [moved] = newOrder.splice(fromIndex, 1);
        if (moved) newOrder.splice(toIndex, 0, moved);
        void api.bookmarks.reorderBar(newOrder);
      });
      button.addEventListener('pointercancel', (event) => {
        if (down?.id !== entry.item.id) return;
        endDrag(button, event);
      });

      if (entry.kind === 'bookmark') {
        button.title = entry.item.url;
        button.addEventListener('click', () => {
          if (suppressClick) {
            suppressClick = false;
            return;
          }
          void api.navigation.navigate(entry.item.url);
        });
        button.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          openPopupFor(button, 'bookmark', entry.item.id);
        });
      } else {
        button.title = entry.item.title;
        button.addEventListener('click', () => {
          if (suppressClick) {
            suppressClick = false;
            return;
          }
          openPopupFor(button, 'folder', entry.item.id);
        });
        button.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          openPopupFor(button, 'folder-menu', entry.item.id);
        });
      }
      container.append(button);
    }
  }

  // Right-click on the bar's own empty space (not an item): add a bookmark or a folder by hand.
  container.addEventListener('contextmenu', (event) => {
    if ((event.target as HTMLElement).closest('.bookmark-item')) return;
    event.preventDefault();
    openPopupAt('add-menu', null, {
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      width: 1,
      height: 1,
    });
  });

  api.bookmarks.onChanged((next) => {
    state = next;
    draw();
  });
  void api.bookmarks.get().then((initial) => {
    state = initial;
    draw();
  });

  api.settings.onChanged((next) => {
    homeOnly = next.values.bookmarksBarHomeOnly;
    draw();
  });
  void api.settings.get().then((initial) => {
    homeOnly = initial.values.bookmarksBarHomeOnly;
    draw();
  });

  api.tabs.onStateChanged((next) => {
    onHomePage = next.tabs.find((tab) => tab.id === next.activeTabId)?.url === '';
    draw();
  });
  void api.tabs.getState().then((initial) => {
    onHomePage = initial.tabs.find((tab) => tab.id === initial.activeTabId)?.url === '';
    draw();
  });
}
