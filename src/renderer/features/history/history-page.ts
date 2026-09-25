import type { BrowserApi } from '~types/browser-api';
import type { HistoryEntry } from '~types/history';
import type { BuiltInPage } from '~types/ui';
import { el } from '../../core/dom';
import { icon } from '../../core/icons';

const PAGE_SIZE = 200;
const SEARCH_DEBOUNCE_MS = 150;
const CONFIRM_CLEAR_MS = 3000;

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayLabel(time: number): string {
  const day = startOfDay(time);
  const today = startOfDay(Date.now());
  if (day === today) return 'Today';
  if (day === startOfDay(today - 1)) return 'Yesterday';
  return new Date(time).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function timeLabel(time: number): string {
  return new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * The History page: search box, visits grouped by day, remove one entry, clear everything.
 * Clicking an entry opens it in this tab. The list is always asked from the main process.
 */
export function createHistoryPage(api: BrowserApi): BuiltInPage {
  const root = el('section', 'hist-page');

  const header = el('header', 'hist-header');
  const search = el('input', 'hist-search');
  search.type = 'search';
  search.placeholder = 'Search history';
  search.spellcheck = false;
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search history');
  const clear = el('button', 'hist-clear', 'Clear all');
  header.append(el('h1', 'hist-title', 'History'), search, clear);

  const list = el('div', 'hist-list');
  root.append(header, list);

  let limit = PAGE_SIZE;
  let visible = false;
  let searchTimer: number | undefined;
  let confirmTimer: number | undefined;

  function renderEntries(entries: HistoryEntry[]): void {
    list.replaceChildren();
    if (entries.length === 0) {
      list.append(
        el('p', 'hist-empty', search.value.trim() === '' ? 'No history yet.' : 'Nothing found.'),
      );
      clear.disabled = search.value.trim() === '';
      return;
    }
    clear.disabled = false;

    let group: HTMLElement | null = null;
    let currentDay = -1;
    for (const entry of entries) {
      const day = startOfDay(entry.visitedAt);
      if (day !== currentDay || group === null) {
        currentDay = day;
        group = el('section', 'hist-group');
        group.append(el('h2', 'hist-day', dayLabel(entry.visitedAt)));
        list.append(group);
      }

      const row = el('div', 'hist-row');
      const open = el('button', 'hist-open');
      open.title = entry.url;
      open.append(
        el('span', 'hist-time', timeLabel(entry.visitedAt)),
        el('span', 'hist-entry-title', entry.title || entry.url),
        el('span', 'hist-url', entry.url),
      );
      open.addEventListener('click', () => {
        void api.navigation.navigate(entry.url);
      });
      const remove = el('button', 'hist-remove');
      remove.append(icon('close'));
      remove.title = 'Remove from history';
      remove.setAttribute('aria-label', 'Remove from history');
      remove.addEventListener('click', () => {
        void api.history.remove(entry.visitedAt);
      });
      row.append(open, remove);
      group.append(row);
    }

    if (entries.length >= limit) {
      const more = el('button', 'hist-more', 'Show more');
      more.addEventListener('click', () => {
        limit += PAGE_SIZE;
        void load();
      });
      list.append(more);
    }
  }

  async function load(): Promise<void> {
    renderEntries(await api.history.query(search.value, limit));
  }

  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      limit = PAGE_SIZE;
      void load();
    }, SEARCH_DEBOUNCE_MS);
  });

  // Clearing everything asks twice: the first click arms the button for a few seconds.
  clear.addEventListener('click', () => {
    if (clear.dataset.armed === 'true') {
      window.clearTimeout(confirmTimer);
      clear.dataset.armed = 'false';
      clear.textContent = 'Clear all';
      void api.history.clear();
      return;
    }
    clear.dataset.armed = 'true';
    clear.textContent = 'Click again to clear all';
    confirmTimer = window.setTimeout(() => {
      clear.dataset.armed = 'false';
      clear.textContent = 'Clear all';
    }, CONFIRM_CLEAR_MS);
  });

  api.history.onChanged(() => {
    if (visible) void load();
  });

  return {
    root,
    show: () => {
      visible = true;
      limit = PAGE_SIZE;
      void load();
      search.focus();
    },
    hide: () => {
      visible = false;
    },
  };
}
