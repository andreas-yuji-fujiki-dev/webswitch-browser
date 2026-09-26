import type { BrowserApi } from '~types/browser-api';
import type { CookieCompanyInfo, CookieInfo, CookiesState } from '~types/cookies';
import type { BuiltInPage } from '~types/ui';
import { el } from '../../core/dom';

const SEARCH_DEBOUNCE_MS = 150;

const FILTERS = [
  { id: 'authentication', label: 'Sign-in' },
  { id: 'all', label: 'All' },
  { id: 'restricted', label: 'Restricted' },
] as const;

function dateLabel(time: number): string {
  return new Date(time).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function guessSite(domain: string): string {
  return domain.replace(/^\./, '').split('.').slice(-2).join('.');
}

function chip(text: string, className = 'ck-chip'): HTMLElement {
  return el('span', className, text);
}

/**
 * The Cookies page (opened from the user icon in the ⋮ menu): every cookie in the browser grouped
 * by company, what it does, when Webswitch first saw it, and controls to disable it, allow it only
 * on some sites, or remove it. Cookie values never reach this page.
 */
export function createCookiesPage(api: BrowserApi): BuiltInPage {
  const root = el('section', 'ck-page');

  const header = el('header', 'ck-header');
  const search = el('input', 'ck-search');
  search.type = 'search';
  search.placeholder = 'Search cookies, sites or companies';
  search.spellcheck = false;
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search cookies');
  const filterBar = el('div', 'ck-filters');
  filterBar.setAttribute('role', 'group');
  // Always there: with no Google cookie yet there is no Google group, and this is how to sign in.
  const google = el('button', 'ck-button ck-panel', 'Google account panel');
  google.title = 'Open your Google account (asks you to sign in when you are not)';
  google.addEventListener('click', () => {
    void api.cookies.openAccountPanel('Google');
  });
  header.append(el('h1', 'ck-title', 'Cookies'), search, filterBar, google);

  const intro = el(
    'p',
    'ck-intro',
    'Cookies keep you signed in to sites. Disable one to stop sending it without losing it, allow it only on the sites you choose, or remove it. WebKit does not keep creation dates, so "first seen" counts from when Webswitch started tracking.',
  );
  const list = el('div', 'ck-list');

  const modal = el('div', 'ck-modal');
  modal.hidden = true;
  root.append(header, intro, list, modal);

  let state: CookiesState = { cookies: [], companies: [] };
  let filter: (typeof FILTERS)[number]['id'] = 'authentication';
  let visible = false;
  let searchTimer: number | undefined;
  let editing: string | null = null;
  let editingCompany: string | null = null;
  let staleWhileEditing = false;
  const collapsed = new Set<string>();

  const filterButtons = FILTERS.map((entry) => {
    const button = el('button', 'ck-filter', entry.label);
    button.addEventListener('click', () => {
      filter = entry.id;
      render();
    });
    filterBar.append(button);
    return { entry, button };
  });

  function matches(cookie: CookieInfo): boolean {
    if (filter === 'authentication' && cookie.kind !== 'authentication') return false;
    if (filter === 'restricted' && cookie.mode === 'active') return false;
    const needle = search.value.trim().toLowerCase();
    if (needle === '') return true;
    return [
      cookie.name,
      cookie.domain,
      cookie.company,
      cookie.kind,
      cookie.explanation,
      ...cookie.sites,
    ]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  }

  /** A confirmation box inside the page (the UI view cannot show native dialogs). */
  function confirm(title: string, message: string, action: string): Promise<boolean> {
    return new Promise((resolve) => {
      modal.replaceChildren();
      const box = el('div', 'ck-dialog');
      const cancel = el('button', 'ck-button', 'Cancel');
      const ok = el('button', 'ck-button ck-danger', action);
      const done = (result: boolean): void => {
        modal.hidden = true;
        window.removeEventListener('keydown', onKey, true);
        resolve(result);
      };
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          done(false);
        }
      };
      cancel.addEventListener('click', () => {
        done(false);
      });
      ok.addEventListener('click', () => {
        done(true);
      });
      const actions = el('div', 'ck-dialog-actions');
      actions.append(cancel, ok);
      box.append(el('h2', 'ck-dialog-title', title), el('p', 'ck-dialog-text', message), actions);
      modal.append(box);
      modal.hidden = false;
      window.addEventListener('keydown', onKey, true);
      cancel.focus();
    });
  }

  async function removeCookies(cookies: CookieInfo[], company: CookieCompanyInfo): Promise<void> {
    if (cookies.length === 0) return;
    const signIn = cookies.some((cookie) => cookie.kind === 'authentication');
    const what =
      cookies.length === 1
        ? `the cookie "${cookies[0]?.name ?? ''}" (${cookies[0]?.domain ?? ''})`
        : `${cookies.length} cookies of ${company.name}`;
    const warning = signIn
      ? company.removalWarning
      : 'Sites may set it again the next time you visit them.';
    if (await confirm(`Remove ${what}?`, warning, 'Remove')) {
      await api.cookies.remove(cookies.map((cookie) => cookie.id));
    }
  }

  function statusBadge(cookie: CookieInfo): HTMLElement | null {
    const via = cookie.origin === 'company' ? ` (${cookie.company} rule)` : '';
    if (cookie.mode === 'disabled') return chip(`Disabled${via}`, 'ck-chip ck-chip-off');
    if (cookie.mode === 'only-on') {
      return chip(`Only on ${cookie.sites.join(', ')}${via}`, 'ck-chip ck-chip-limited');
    }
    return null;
  }

  function renderEditor(cookie: CookieInfo): HTMLElement {
    const form = el('form', 'ck-editor');
    const input = el('input', 'ck-editor-input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = cookie.sites.length > 0 ? cookie.sites.join(', ') : guessSite(cookie.domain);
    input.placeholder = 'example.com, other.org';
    input.setAttribute('aria-label', 'Sites where this cookie may be used');
    const save = el('button', 'ck-button', 'Allow only there');
    save.type = 'submit';
    const cancel = el('button', 'ck-button', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      editing = null;
      render();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const sites = input.value.split(/[\s,;]+/).filter((site) => site !== '');
      editing = null;
      void api.cookies
        .setPolicy([cookie.id], { mode: 'only-on', sites })
        .then(() => (staleWhileEditing ? load() : undefined));
    });
    form.append(
      el('span', 'ck-editor-label', 'Send it only while a tab is on:'),
      input,
      save,
      cancel,
    );
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return form;
  }

  function renderRow(cookie: CookieInfo): HTMLElement {
    const row = el('article', 'ck-row');
    row.dataset.mode = cookie.mode;

    const top = el('div', 'ck-row-top');
    const name = el('span', 'ck-name', cookie.name);
    name.title = cookie.name;
    top.append(name);
    const badge = statusBadge(cookie);
    if (badge) top.append(badge);

    const actions = el('div', 'ck-actions');
    const toggle = el('button', 'ck-button', cookie.mode === 'active' ? 'Disable' : 'Enable');
    toggle.title =
      cookie.mode === 'active'
        ? 'Stop sending this cookie, but keep it so you can enable it again'
        : 'Send this cookie again, everywhere';
    toggle.addEventListener('click', () => {
      void api.cookies.setPolicy([cookie.id], {
        mode: cookie.mode === 'active' ? 'disabled' : 'active',
        sites: [],
      });
    });
    const only = el('button', 'ck-button', 'Only on…');
    only.title = 'Allow this cookie only while a tab shows the sites you choose';
    only.addEventListener('click', () => {
      editing = editing === cookie.id ? null : cookie.id;
      render();
    });
    const remove = el('button', 'ck-button ck-danger', 'Remove');
    remove.addEventListener('click', () => {
      const company = state.companies.find((entry) => entry.name === cookie.company);
      void removeCookies(
        [cookie],
        company ?? {
          name: cookie.company,
          accountPanel: null,
          removalWarning: '',
          mode: 'active',
          sites: [],
        },
      );
    });
    actions.append(toggle, only, remove);
    top.append(actions);

    const meta = el('div', 'ck-meta');
    meta.append(
      el('span', 'ck-domain', `${cookie.domain}${cookie.path}`),
      el(
        'span',
        'ck-fact',
        cookie.firstSeen === null
          ? 'First seen: before tracking'
          : `First seen ${dateLabel(cookie.firstSeen)}`,
      ),
      el(
        'span',
        'ck-fact',
        cookie.expires === null ? 'Session' : `Expires ${dateLabel(cookie.expires)}`,
      ),
    );
    if (cookie.secure) meta.append(chip('Secure'));
    if (cookie.httpOnly) meta.append(chip('HttpOnly'));
    meta.append(chip(`SameSite ${cookie.sameSite}`));
    meta.append(chip(cookie.kind, `ck-chip ck-kind-${cookie.kind}`));

    row.append(top, meta, el('p', 'ck-explain', cookie.explanation));
    if (editing === cookie.id) row.append(renderEditor(cookie));
    return row;
  }

  /** The rule that covers every cookie of the company, the ones it has and the ones it sets later. */
  function renderRuleBar(company: CookieCompanyInfo): HTMLElement {
    const bar = el('div', 'ck-rule');
    const owned = state.cookies.filter((cookie) => cookie.company === company.name);
    bar.append(
      el(
        'span',
        'ck-rule-label',
        `Rule for all ${owned.length} ${company.name} cookies, including new ones:`,
      ),
    );
    const modes = [
      { mode: 'active', label: 'Allowed everywhere' },
      { mode: 'disabled', label: 'Disabled' },
      { mode: 'only-on', label: 'Only on…' },
    ] as const;
    const choices = el('span', 'ck-rule-choices');
    for (const choice of modes) {
      const button = el('button', 'ck-button ck-rule-choice', choice.label);
      button.dataset.active = String(company.mode === choice.mode);
      button.addEventListener('click', () => {
        if (choice.mode === 'only-on') {
          editingCompany = editingCompany === company.name ? null : company.name;
          render();
        } else {
          editingCompany = null;
          void api.cookies.setCompanyPolicy(company.name, { mode: choice.mode, sites: [] });
        }
      });
      choices.append(button);
    }
    bar.append(choices);

    if (editingCompany === company.name) {
      const form = el('form', 'ck-editor');
      const input = el('input', 'ck-editor-input');
      input.type = 'text';
      input.spellcheck = false;
      input.value =
        company.sites.length > 0
          ? company.sites.join(', ')
          : [...new Set(owned.map((cookie) => guessSite(cookie.domain)))].join(', ');
      input.placeholder = 'example.com, other.org';
      input.setAttribute('aria-label', `Sites where ${company.name} cookies may be used`);
      const save = el('button', 'ck-button', 'Apply to all');
      save.type = 'submit';
      const cancel = el('button', 'ck-button', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => {
        editingCompany = null;
        render();
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const sites = input.value.split(/[\s,;]+/).filter((site) => site !== '');
        editingCompany = null;
        void api.cookies
          .setCompanyPolicy(company.name, { mode: 'only-on', sites })
          .then(() => (staleWhileEditing ? load() : undefined));
      });
      form.append(
        el('span', 'ck-editor-label', `Send every ${company.name} cookie only while a tab is on:`),
        input,
        save,
        cancel,
      );
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
      bar.append(form);
    } else if (company.mode === 'only-on') {
      bar.append(el('span', 'ck-rule-sites', `Only on ${company.sites.join(', ')}`));
    }
    return bar;
  }

  function renderGroup(company: CookieCompanyInfo, cookies: CookieInfo[]): HTMLElement {
    const group = el('details', 'ck-group');
    group.open = !collapsed.has(company.name);
    group.addEventListener('toggle', () => {
      if (group.open) collapsed.delete(company.name);
      else collapsed.add(company.name);
    });

    const summary = el('summary', 'ck-group-head');
    summary.append(
      el('span', 'ck-company', company.name),
      el('span', 'ck-count', `${cookies.length} ${cookies.length === 1 ? 'cookie' : 'cookies'}`),
    );
    const bulk = el('span', 'ck-group-actions');
    // Buttons inside <summary> must not also toggle the group.
    const stop = (button: HTMLElement, run: () => void): void => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        run();
      });
    };
    if (company.accountPanel) {
      const panel = el('button', 'ck-button ck-panel', company.accountPanel.label);
      panel.title = `Open ${company.accountPanel.url}`;
      stop(panel, () => {
        void api.cookies.openAccountPanel(company.name);
      });
      bulk.append(panel);
    }
    const removeAll = el('button', 'ck-button ck-danger', 'Remove all');
    stop(removeAll, () => {
      void removeCookies(cookies, company);
    });
    bulk.append(removeAll);
    summary.append(bulk);

    group.append(summary, renderRuleBar(company), ...cookies.map(renderRow));
    return group;
  }

  function render(): void {
    // The Google group has its own panel button once a Google cookie exists.
    google.hidden = state.cookies.some((cookie) => cookie.company === 'Google');
    for (const { entry, button } of filterButtons) {
      button.dataset.active = String(entry.id === filter);
    }
    list.replaceChildren();
    const shown = state.cookies.filter(matches);
    if (shown.length === 0) {
      const empty =
        state.cookies.length === 0
          ? 'No cookies yet. Sign in to a site and it will show up here.'
          : filter === 'authentication'
            ? 'No sign-in cookies match. Try "All" to see every cookie.'
            : 'Nothing found.';
      list.append(el('p', 'ck-empty', empty));
      return;
    }
    for (const company of state.companies) {
      const cookies = shown.filter((cookie) => cookie.company === company.name);
      if (cookies.length > 0) list.append(renderGroup(company, cookies));
    }
  }

  async function load(): Promise<void> {
    staleWhileEditing = false;
    state = await api.cookies.get();
    render();
  }

  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(render, SEARCH_DEBOUNCE_MS);
  });

  api.cookies.onChanged(() => {
    if (!visible) return;
    // Redrawing would throw away what is being typed in the "only on" editor.
    if (editing !== null || editingCompany !== null) staleWhileEditing = true;
    else void load();
  });

  return {
    root,
    show: () => {
      visible = true;
      editing = null;
      editingCompany = null;
      void load();
      search.focus();
    },
    hide: () => {
      visible = false;
    },
  };
}
