import { BUILTIN_THEMES, DARK_THEME, LIGHT_THEME, SYSTEM_THEME } from '~shared/themes-catalog';
import type { BrowserApi } from '~types/browser-api';
import type { ThemeColors, ThemeInfo, ThemeResult, ThemesState } from '~types/themes';
import type { BuiltInPage } from '~types/ui';
import { el } from '../../core/dom';
import { createVsxPanel } from './themes-vsx';

const TEMPLATE = `{
  "name": "My theme",
  "author": "me",
  "scheme": "dark",
  "colors": {
    "bg": "#101418",
    "fg": "#e6e6e6",
    "accent": "#ff8800"
  }
}`;

const HELP =
  'Only "name" and the colors "bg", "fg" and "accent" are needed; the others (raised, hover, border, fgStrong, fgSoft, fgMuted, info, success, danger) are worked out from them when left out. Colors are #rgb or #rrggbb. "scheme" is "dark" or "light" (it is guessed from bg when left out).';

/** A small picture of the UI in a theme's colors: the strip with tabs, the address bar, some text. */
function preview(colors: ThemeColors): HTMLElement {
  const box = el('div', 'theme-preview');
  box.style.setProperty('--p-bg', colors.bg);
  box.style.setProperty('--p-raised', colors.raised);
  box.style.setProperty('--p-hover', colors.hover);
  box.style.setProperty('--p-border', colors.border);
  box.style.setProperty('--p-fg', colors.fg);
  box.style.setProperty('--p-strong', colors.fgStrong);
  box.style.setProperty('--p-muted', colors.fgMuted);
  box.style.setProperty('--p-accent', colors.accent);
  const strip = el('div', 'theme-preview__strip');
  strip.append(
    el('span', 'theme-preview__tab theme-preview__tab--active'),
    el('span', 'theme-preview__tab'),
  );
  const bar = el('div', 'theme-preview__bar');
  bar.append(el('span', 'theme-preview__input'));
  const page = el('div', 'theme-preview__page');
  page.append(
    el('span', 'theme-preview__line theme-preview__line--strong'),
    el('span', 'theme-preview__line'),
    el('span', 'theme-preview__line theme-preview__line--muted'),
  );
  const swatches = el('div', 'theme-preview__swatches');
  for (const key of ['accent', 'info', 'success', 'danger'] as const) {
    const dot = el('span', 'theme-preview__dot');
    dot.style.background = colors[key];
    swatches.append(dot);
  }
  page.append(swatches);
  box.append(strip, bar, page);
  return box;
}

/**
 * The Themes page: pick a theme (each shown as a small picture), or add one, from a JSON file or
 * pasted text. The main process validates every theme; this shows them and sends the clicks.
 */
export function createThemesPage(api: BrowserApi): BuiltInPage {
  const root = el('section', 'themes-page');
  let state: ThemesState | null = null;

  const header = el('header', 'themes-header');
  header.append(el('h1', 'themes-title', 'Themes'));
  const addToggle = el('button', 'themes-button themes-button--primary', 'Add theme');
  const vsxToggle = el('button', 'themes-button', 'VS Code themes');
  vsxToggle.title = 'Find themes from the VS Code extension registry';
  header.append(el('div', 'themes-header__buttons'));
  header.lastElementChild?.append(vsxToggle, addToggle);

  // ── Adding a theme ──
  const addPanel = el('section', 'themes-add');
  addPanel.hidden = true;
  addPanel.append(el('h2', 'themes-add__title', 'Add a theme'));
  addPanel.append(el('p', 'themes-help', HELP));
  const fileButton = el('button', 'themes-button', 'Choose a file…');
  const paste = el('textarea', 'themes-paste');
  paste.placeholder = TEMPLATE;
  paste.rows = 9;
  paste.spellcheck = false;
  paste.setAttribute('aria-label', 'Theme JSON');
  const addButton = el('button', 'themes-button themes-button--primary', 'Add this theme');
  const templateButton = el('button', 'themes-button', 'Fill in an example');
  const message = el('p', 'themes-message');
  message.hidden = true;
  const actions = el('div', 'themes-add__actions');
  actions.append(addButton, templateButton);
  addPanel.append(fileButton, el('p', 'themes-or', 'or paste it here:'), paste, actions, message);

  function say(text: string, error: boolean): void {
    message.hidden = false;
    message.textContent = text;
    message.dataset.error = String(error);
  }
  function handled(result: ThemeResult | null): void {
    if (result === null) return;
    if (result.ok) {
      say('Theme added. Pick it below to use it.', false);
      paste.value = '';
    } else {
      say(result.error, true);
    }
  }
  addToggle.addEventListener('click', () => {
    addPanel.hidden = !addPanel.hidden;
    addToggle.textContent = addPanel.hidden ? 'Add theme' : 'Close';
    message.hidden = true;
  });
  fileButton.addEventListener('click', () => {
    void api.themes.importFile().then(handled);
  });
  addButton.addEventListener('click', () => {
    void api.themes.add(paste.value).then(handled);
  });
  templateButton.addEventListener('click', () => {
    paste.value = TEMPLATE;
    paste.focus();
  });

  const vsx = createVsxPanel(api);
  vsxToggle.addEventListener('click', () => {
    vsx.open();
  });
  const grid = el('ul', 'themes-grid');
  root.append(header, vsx.root, addPanel, grid);

  function card(
    id: string,
    name: string,
    byline: string,
    picture: HTMLElement,
    theme?: ThemeInfo,
  ): HTMLElement {
    const item = el('li', 'theme-card');
    const inUse = state?.active === id;
    item.dataset.active = String(inUse);
    item.dataset.theme = id;
    item.append(picture);
    const info = el('div', 'theme-card__info');
    info.append(el('span', 'theme-card__name', name), el('span', 'theme-card__by', byline));
    const buttons = el('div', 'theme-card__buttons');
    if (inUse) {
      buttons.append(el('span', 'theme-card__badge', 'In use'));
    } else {
      const use = el('button', 'themes-button themes-button--primary', 'Use');
      use.addEventListener('click', () => {
        void api.themes.select(id);
      });
      buttons.append(use);
    }
    if (theme && !theme.builtin) {
      const remove = el('button', 'themes-button', 'Remove');
      remove.title = 'Delete this theme';
      remove.addEventListener('click', () => {
        void api.themes.remove(id);
      });
      buttons.append(remove);
    }
    info.append(buttons);
    item.append(info);
    return item;
  }

  function render(next: ThemesState): void {
    state = next;
    vsx.update(next);
    const dark = BUILTIN_THEMES.find((theme) => theme.id === DARK_THEME);
    const light = BUILTIN_THEMES.find((theme) => theme.id === LIGHT_THEME);
    const cards: HTMLElement[] = [];
    if (dark && light) {
      const both = el('div', 'theme-split');
      both.append(preview(dark.colors), preview(light.colors));
      cards.push(
        card(SYSTEM_THEME, 'Automatic', 'Webswitch Dark or Light, like your desktop', both),
      );
    }
    for (const theme of next.themes) {
      cards.push(
        card(
          theme.id,
          theme.name,
          [
            theme.author,
            theme.scheme,
            theme.license,
            theme.builtin ? null : theme.source ? 'from Open VSX' : 'added by you',
          ]
            .filter(Boolean)
            .join(' · '),
          preview(theme.colors),
          theme,
        ),
      );
    }
    grid.replaceChildren(...cards);
  }

  api.themes.onChanged(render);
  void api.themes.get().then(render);

  return { root, show: () => undefined, hide: () => undefined };
}
