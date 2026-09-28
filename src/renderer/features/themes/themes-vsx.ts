import type { BrowserApi } from '~types/browser-api';
import type { ThemesState, VsxResult, VsxSort } from '~types/themes';
import { el } from '../../core/dom';

const POPULAR = 25;
const SORTS: [VsxSort, string][] = [
  ['downloadCount', 'Most downloaded'],
  ['averageRating', 'Best rated'],
  ['timestamp', 'Newest'],
  ['relevance', 'Best match'],
];

function count(value: number): string {
  return value >= 1e6
    ? `${(value / 1e6).toFixed(1)}M`
    : value >= 1e3
      ? `${Math.round(value / 1e3)}k`
      : String(value);
}

/**
 * The panel that finds VS Code color themes on Open VSX, the open registry of VS Code extensions,
 * and installs them as Webswitch themes. It asks the network only when a button says so.
 */
export function createVsxPanel(api: BrowserApi): {
  root: HTMLElement;
  open: () => void;
  update: (state: ThemesState) => void;
} {
  const root = el('section', 'themes-vsx');
  root.hidden = true;
  root.append(el('h2', 'themes-add__title', 'VS Code themes'));
  root.append(
    el(
      'p',
      'themes-help',
      "Thousands of color themes from the VS Code extension registry Open VSX (the same themes vscodethemes.com lists from Microsoft's Marketplace, which only Microsoft's own products may use). Each theme keeps its own license, shown on its card. Searching and installing are the only things here that use the network, and only when you press them.",
    ),
  );

  const popular = el(
    'button',
    'themes-button themes-button--primary',
    `Install the ${String(POPULAR)} most popular`,
  );
  const form = el('div', 'themes-vsx__form');
  const query = el('input', 'themes-vsx__query');
  query.type = 'search';
  query.placeholder = 'Search themes (Dracula, Tokyo Night, Catppuccin…)';
  query.setAttribute('aria-label', 'Search VS Code themes');
  const sort = el('select', 'themes-vsx__sort');
  sort.setAttribute('aria-label', 'Order');
  for (const [value, label] of SORTS) {
    const option = el('option', '', label);
    option.value = value;
    sort.append(option);
  }
  const search = el('button', 'themes-button', 'Search');
  form.append(query, sort, search);

  const status = el('p', 'themes-vsx__status');
  const list = el('ul', 'themes-vsx__list');
  const more = el('button', 'themes-button', 'Load more');
  more.hidden = true;
  root.append(popular, form, status, list, more);

  let shown = 0;
  let total = 0;
  let searching = false;
  let busy = false;
  let wasBusy = false;
  const messages = new Map<string, string>();

  function row(result: VsxResult): HTMLElement {
    const item = el('li', 'themes-vsx__item');
    const text = el('div', 'themes-vsx__text');
    const head = el('div', 'themes-vsx__head');
    head.append(
      el('span', 'themes-vsx__name', result.displayName),
      el(
        'span',
        'themes-vsx__by',
        `${result.namespace} · ${count(result.downloads)} downloads${result.rating !== null ? ` · ${result.rating.toFixed(1)} ★` : ''}`,
      ),
    );
    text.append(head, el('p', 'themes-vsx__desc', result.description));
    const note = messages.get(result.id);
    if (note) text.append(el('p', 'themes-vsx__note', note));
    const button = el(
      'button',
      'themes-button themes-button--primary',
      result.installed ? 'Installed' : 'Install',
    );
    button.disabled = result.installed || busy;
    button.addEventListener('click', () => {
      busy = true;
      messages.set(result.id, 'Installing…');
      redraw();
      void api.themes.installVsx(result.namespace, result.name).then((answer) => {
        busy = false;
        messages.set(result.id, answer.ok ? `Added: ${answer.added.join(', ')}` : answer.error);
        if (answer.ok) result.installed = true;
        redraw();
      });
    });
    item.append(text, button);
    return item;
  }

  const results: VsxResult[] = [];
  function redraw(): void {
    list.replaceChildren(...results.map(row));
    more.hidden = shown >= total;
    more.disabled = searching;
    popular.disabled = busy || searching;
    search.disabled = searching;
  }

  async function run(fresh: boolean): Promise<void> {
    if (fresh) {
      results.length = 0;
      shown = 0;
    }
    searching = true;
    status.textContent = 'Searching…';
    redraw();
    try {
      const answer = await api.themes.searchVsx(query.value, shown, sort.value as VsxSort);
      results.push(...answer.results);
      shown += answer.results.length;
      total = answer.total;
      status.textContent = `${String(total)} themes found.`;
    } catch {
      status.textContent = 'Could not reach Open VSX.';
    }
    searching = false;
    redraw();
  }

  search.addEventListener('click', () => {
    void run(true);
  });
  query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void run(true);
  });
  sort.addEventListener('change', () => {
    void run(true);
  });
  more.addEventListener('click', () => {
    void run(false);
  });
  popular.addEventListener('click', () => {
    busy = true;
    status.textContent = `Installing the ${String(POPULAR)} most popular…`;
    redraw();
    void api.themes.installPopular(POPULAR).then((answer) => {
      busy = false;
      status.textContent = answer.ok
        ? `Added ${String(answer.added.length)} themes.`
        : answer.error;
      // What is installed shows on the cards.
      void run(true);
    });
  });

  return {
    root,
    open: () => {
      // Opening it asks for nothing: the network is used when Search or Install is pressed.
      root.hidden = !root.hidden;
      if (!root.hidden && results.length === 0) {
        status.textContent =
          'Press Search to list the themes (leave the box empty for the most downloaded).';
      }
    },
    update: (state) => {
      if (state.busy) {
        wasBusy = true;
        status.textContent = `${state.busy.text} (${String(state.busy.done)} of ${String(state.busy.total)})`;
      } else if (wasBusy) {
        wasBusy = false;
        status.textContent = 'Done.';
      }
    },
  };
}
