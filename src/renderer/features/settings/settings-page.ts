import { SETTING_SECTIONS, SETTINGS } from '~shared/settings-catalog';
import type { BrowserApi } from '~types/browser-api';
import type {
  Setting,
  SettingEffect,
  SettingId,
  SettingsState,
  SettingValue,
} from '~types/settings';
import type { BuiltInPage, SettingsRow } from '~types/ui';
import { el } from '../../core/dom';

const EFFECT_HINTS: Record<SettingEffect, string> = {
  now: '',
  reload: 'Applies to pages you load next',
  restart: 'Needs a restart',
};

/**
 * The General settings page. Every row is drawn from `SETTINGS` once and only updated afterwards.
 * The main process owns the values and validates every change; this shows them and sends edits.
 * A change that needs a restart raises a banner with a button that restarts the browser.
 */
export function createSettingsPage(api: BrowserApi): BuiltInPage {
  const root = el('section', 'set-page');
  const errors = new Map<SettingId, string>();
  let state: SettingsState | null = null;

  async function save(id: SettingId, value: SettingValue): Promise<void> {
    const result = await api.settings.set(id, value);
    if (result.ok) errors.delete(id);
    else errors.set(id, result.error);
    if (state) update(state);
  }

  function buildControl(definition: Setting): {
    control: HTMLElement;
    show: (value: SettingValue) => void;
  } {
    switch (definition.kind) {
      case 'toggle': {
        const button = el('button', 'set-switch');
        button.setAttribute('role', 'switch');
        button.setAttribute('aria-label', definition.label);
        button.append(el('span', 'set-switch__knob'));
        button.addEventListener('click', () => {
          void save(definition.id, button.getAttribute('aria-checked') !== 'true');
        });
        return {
          control: button,
          show: (value) => {
            button.setAttribute('aria-checked', String(value === true));
          },
        };
      }
      case 'choice': {
        const select = el('select', 'set-select');
        select.setAttribute('aria-label', definition.label);
        for (const option of definition.options) {
          const item = el('option', '', option.label);
          item.value = option.value;
          select.append(item);
        }
        select.addEventListener('change', () => {
          void save(definition.id, select.value);
        });
        return {
          control: select,
          show: (value) => {
            select.value = String(value);
          },
        };
      }
      case 'text': {
        const input = el('input', 'set-input');
        input.type = 'text';
        input.placeholder = definition.placeholder;
        input.spellcheck = false;
        input.setAttribute('aria-label', definition.label);
        // A folder path is checked by the main process, so it is sent when the field is left.
        input.addEventListener('change', () => {
          void save(definition.id, input.value);
        });
        return {
          control: input,
          show: (value) => {
            // The field being typed in is left alone; it is redrawn once the value was saved.
            if (document.activeElement !== input) input.value = String(value);
          },
        };
      }
    }
  }

  function buildRow(definition: Setting): SettingsRow {
    const row = el('li', 'set-row');
    const text = el('div', 'set-text');
    const label = el('span', 'set-label', definition.label);
    const hint = el('span', 'set-hint', EFFECT_HINTS[definition.effect]);
    hint.hidden = definition.effect === 'now';
    const heading = el('div', 'set-heading');
    heading.append(label, hint);
    const description = el('p', 'set-description', definition.description);
    const note = el('p', 'set-note');
    const error = el('p', 'set-error');
    text.append(heading, description, note, error);

    const { control, show } = buildControl(definition);
    const reset = el('button', 'set-reset', 'Reset');
    reset.addEventListener('click', () => {
      errors.delete(definition.id);
      void api.settings.reset(definition.id);
    });
    const side = el('div', 'set-side');
    side.append(control, reset);
    row.append(text, side);

    return {
      definition,
      root: row,
      section: definition.section,
      update: (next) => {
        const value = next.values[definition.id];
        show(value);
        reset.hidden = value === definition.default;
        const overridden = next.overriddenByEnv.includes(definition.id);
        note.hidden = !overridden;
        note.textContent = overridden
          ? 'An environment variable (WEBSWITCH_*) sets this while the browser runs; your choice applies without it.'
          : '';
        const message = errors.get(definition.id);
        error.hidden = message === undefined;
        error.textContent = message ?? '';
        row.dataset.pending = String(next.restartPending.includes(definition.id));
      },
    };
  }

  const rows = SETTINGS.map((definition) => buildRow(definition));

  // The header: title, search and "Reset all".
  const title = el('h1', 'set-title', 'General settings');
  const search = el('input', 'set-search');
  search.type = 'search';
  search.placeholder = 'Search settings';
  search.setAttribute('aria-label', 'Search settings');
  const resetAll = el('button', 'set-reset-all', 'Reset all');
  resetAll.addEventListener('click', () => {
    errors.clear();
    void api.settings.resetAll();
  });
  const header = el('header', 'set-header');
  header.append(title, search, resetAll);

  // The banner that offers the restart.
  const banner = el('div', 'set-banner');
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  const bannerText = el('p', 'set-banner__text');
  const restart = el('button', 'set-banner__button', 'Restart now');
  restart.addEventListener('click', () => {
    restart.disabled = true;
    restart.textContent = 'Restarting…';
    void api.settings.restart();
  });
  banner.append(bannerText, restart);

  const sections = SETTING_SECTIONS.map((section) => {
    const box = el('section', 'set-section');
    const list = el('ul', 'set-list');
    for (const row of rows) if (row.section === section.id) list.append(row.root);
    box.append(el('h2', 'set-section__title', section.label), list);
    return { box, list };
  });
  const empty = el('p', 'set-empty', 'No setting matches.');
  empty.hidden = true;

  root.append(header, banner, ...sections.map((section) => section.box), empty);

  function filter(): void {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const row of rows) {
      const haystack = `${row.definition.label} ${row.definition.description}`.toLowerCase();
      row.root.hidden = !words.every((word) => haystack.includes(word));
      if (!row.root.hidden) shown++;
    }
    for (const { box, list } of sections) {
      box.hidden = [...list.children].every((child) => (child as HTMLElement).hidden);
    }
    empty.hidden = shown > 0;
  }
  search.addEventListener('input', filter);

  function update(next: SettingsState): void {
    state = next;
    for (const row of rows) row.update(next);
    resetAll.disabled = SETTINGS.every(
      (definition) => next.values[definition.id] === definition.default,
    );

    const pending = SETTINGS.filter((definition) => next.restartPending.includes(definition.id));
    banner.hidden = pending.length === 0;
    if (pending.length > 0) {
      bannerText.textContent = `Restart to apply: ${pending.map((d) => d.label).join('; ')}. The pages that are open now are opened again.`;
      restart.disabled = false;
      restart.textContent = 'Restart now';
    }
  }

  api.settings.onChanged(update);
  void api.settings.get().then(update);
  filter();

  return { root, show: () => undefined, hide: () => undefined };
}
