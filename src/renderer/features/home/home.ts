import { SETTINGS } from '~shared/settings-catalog';
import type { BrowserApi } from '~types/browser-api';
import { el } from '../../core/dom';

const ENGINE_SETTING = SETTINGS.find((setting) => setting.id === 'searchEngine');

/**
 * The home page of a blank tab: the .webswitch wordmark with a real text field where its blinking
 * cursor used to be. Type there and press Enter to search or go to an address (the same rules as
 * the address bar), and pick the search engine from the list under the wordmark, at its left.
 */
export function createHome(api: BrowserApi): { root: HTMLElement; focus: () => void } {
  const root = el('div', 'home');

  // The search engine: the same choice as in General settings.
  const engine = el('label', 'home__engine');
  const select = el('select', 'home__engine-select');
  select.setAttribute('aria-label', 'Search engine');
  for (const option of ENGINE_SETTING?.kind === 'choice' ? ENGINE_SETTING.options : []) {
    const item = el('option', '', option.label);
    item.value = option.value;
    select.append(item);
  }
  select.addEventListener('change', () => {
    void api.settings.set('searchEngine', select.value);
    input.focus();
  });
  // A select is as wide as its longest option, which leaves the arrow far from a shorter name. A
  // hidden copy of the chosen name is measured and the select is made that wide (plus the arrow).
  const engineMeasure = el('span', 'home__engine-measure');
  engineMeasure.setAttribute('aria-hidden', 'true');
  const fit = (): void => {
    engineMeasure.textContent = select.selectedOptions[0]?.textContent ?? '';
    const width = Math.ceil(engineMeasure.getBoundingClientRect().width);
    // Not laid out yet (the page is not on screen): leave the width alone, it is measured again
    // as soon as the copy has a size. A select forced to 0 wide would show no text at all.
    select.style.width = width > 0 ? `${String(width)}px` : '';
  };
  // The copy only has a size once the home page is in the document, and again when a font arrives.
  new ResizeObserver(fit).observe(engineMeasure);
  select.addEventListener('change', fit);
  engine.append(select, engineMeasure);

  // The wordmark, and the field that takes the place of its cursor.
  const wordmark = el('p', 'wordmark');
  const field = el('span', 'wordmark__field');
  const input = el('input', 'wordmark__input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Search or enter an address');
  field.append(input);
  // Reads like the address of a search: .webswitch/?q=<what you type>. The path part is dimmed.
  wordmark.append(
    el('span', 'wordmark__dim', '.web'),
    'switch',
    el('span', 'wordmark__dim', '/?q='),
    field,
  );

  // The field grows with what is typed: the hidden copy of the text in `data-value` sets its width.
  const measure = (): void => {
    field.dataset.value = input.value;
  };
  input.addEventListener('input', measure);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const text = input.value.trim();
      if (text === '') return;
      input.value = '';
      measure();
      void api.navigation.navigate(text);
    } else if (event.key === 'Escape') {
      input.value = '';
      measure();
    }
  });
  measure();

  root.append(wordmark, engine);
  // A click anywhere on the wordmark is a click into the field.
  wordmark.addEventListener('click', () => {
    input.focus();
  });

  // Typing with nothing focused starts the search here, as if the cursor had been clicked first.
  window.addEventListener('keydown', (event) => {
    if (!root.isConnected || document.activeElement !== document.body) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.key.length !== 1) return;
    input.focus();
  });

  const showEngine = (value: string): void => {
    select.value = value;
    fit();
  };
  // The fonts of the page may arrive after the first measure.
  void document.fonts.ready.then(fit);
  void api.settings.get().then((state) => {
    showEngine(state.values.searchEngine);
  });
  api.settings.onChanged((state) => {
    showEngine(state.values.searchEngine);
  });

  return {
    root,
    focus: () => {
      if (document.activeElement === document.body) input.focus();
    },
  };
}
