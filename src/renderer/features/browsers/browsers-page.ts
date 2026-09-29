import { BROWSERS } from '~shared/browsers-catalog';
import { compareVersions } from '~shared/version';
import type { BrowserId, BrowserResult, BrowsersState, BrowserStatus } from '~types/browsers';
import type { BrowserApi } from '~types/browser-api';
import type { BuiltInPage } from '~types/ui';
import { el } from '../../core/dom';

const LATEST = 'latest';
const PHASES = {
  listing: 'Asking the vendor…',
  downloading: 'Downloading',
  verifying: 'Checking the download…',
  unpacking: 'Unpacking…',
  removing: 'Removing…',
} as const;

function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/**
 * The page behind the gear in the menu's row of browsers. It installs the bases of other browsers
 * (Chrome for Testing, Firefox, Opera, Edge) so a page can be opened in them inside a tab, keeps them
 * up to date, lets the release be chosen, uninstalls what is not needed and shows what each takes on
 * disk. The main process owns the state; this shows it and sends the clicks. Nothing goes to the
 * network until a button says so.
 */
export function createBrowsersPage(api: BrowserApi): BuiltInPage {
  const root = el('section', 'br-page');
  let state: BrowsersState | null = null;
  const chosen = new Map<BrowserId, string>();
  const errors = new Map<BrowserId, string>();
  let handledFocus = 0;

  async function run(id: BrowserId, action: Promise<BrowserResult>): Promise<void> {
    const result = await action;
    if (result.ok) errors.delete(id);
    else errors.set(id, result.error);
    if (state) render(state);
  }

  function card(browser: (typeof BROWSERS)[number], status: BrowserStatus): HTMLElement {
    const item = el('li', 'br-card');
    item.dataset.browser = browser.id;
    const head = el('div', 'br-head');
    head.append(
      el('span', 'br-name', browser.name),
      el('span', 'br-badge', browser.engine),
      ...(browser.tier === 'extra' ? [el('span', 'br-badge br-badge--extra', 'Extra')] : []),
    );
    if (status.updateAvailable)
      head.append(el('span', 'br-badge br-badge--update', 'Update available'));
    item.append(head, el('p', 'br-description', browser.description));

    if (browser.source === 'builtin') {
      const open = el('button', 'br-button br-button--primary', 'Open this page in a new tab');
      open.addEventListener('click', () => {
        void api.browsers.open(browser.id);
      });
      item.append(open);
      return item;
    }

    const busy = status.busy;
    // The releases that are here, each with what it takes on disk.
    if (status.installed.length > 0) {
      const list = el('ul', 'br-versions');
      for (const release of status.installed) {
        const row = el('li', 'br-version');
        row.dataset.active = String(release.active);
        row.append(
          el('span', 'br-version__number', release.version),
          el('span', 'br-version__size', size(release.sizeBytes)),
        );
        if (release.active) {
          row.append(el('span', 'br-version__in-use', 'In use'));
        } else {
          const use = el('button', 'br-button', 'Use');
          use.disabled = busy !== null;
          use.addEventListener('click', () => {
            void run(browser.id, api.browsers.use(browser.id, release.version));
          });
          row.append(use);
        }
        const remove = el('button', 'br-button', 'Uninstall');
        remove.title = `Delete this release (frees ${size(release.sizeBytes)})`;
        remove.disabled = busy !== null;
        remove.addEventListener('click', () => {
          void run(browser.id, api.browsers.uninstall(browser.id, release.version));
        });
        row.append(remove);
        list.append(row);
      }
      item.append(list);
    }

    // Installing: the newest, or one from the last check.
    const controls = el('div', 'br-install');
    const select = el('select', 'br-select');
    select.setAttribute('aria-label', `${browser.name} release`);
    const latestLabel = status.latest ? `Latest (${status.latest})` : 'Latest';
    for (const value of [LATEST, ...status.versions]) {
      const option = el('option', '', value === LATEST ? latestLabel : value);
      option.value = value;
      select.append(option);
    }
    select.value = chosen.get(browser.id) ?? LATEST;
    if (select.value !== (chosen.get(browser.id) ?? LATEST)) select.value = LATEST;
    select.disabled = busy !== null;
    select.addEventListener('change', () => {
      chosen.set(browser.id, select.value);
      if (state) render(state);
    });
    const wanted = select.value === LATEST ? status.latest : select.value;
    const newest = status.installed[0]?.version;
    const installed = status.installed.some((release) => release.version === wanted);
    let label = wanted ? `Install ${wanted}` : 'Install latest';
    if (newest !== undefined && wanted && !installed) {
      label = `${compareVersions(wanted.replace(/esr$/, ''), newest.replace(/esr$/, '')) > 0 ? 'Update to' : 'Install'} ${wanted}`;
    }
    const install = el('button', 'br-button br-button--primary', label);
    install.disabled = busy !== null;
    // The release already here has nothing to install.
    install.hidden = installed;
    install.addEventListener('click', () => {
      errors.delete(browser.id);
      void run(
        browser.id,
        api.browsers.install(browser.id, select.value === LATEST ? undefined : select.value),
      );
    });
    controls.append(select, install);
    if (status.installed.length > 0) {
      const open = el('button', 'br-button', 'Open this page');
      open.title = `Open the page you are on in ${browser.name}, inside a tab`;
      open.addEventListener('click', () => {
        void run(browser.id, api.browsers.open(browser.id));
      });
      controls.append(open);
    }
    item.append(controls);

    if (busy) {
      const line = el('div', 'br-busy');
      line.append(
        el(
          'span',
          'br-busy__text',
          `${PHASES[busy.phase]}${busy.version ? ` ${busy.version}` : ''}${busy.percent !== null ? ` ${String(busy.percent)}%` : ''}`,
        ),
      );
      if (busy.percent !== null) {
        const bar = el('progress', 'br-progress');
        bar.max = 100;
        bar.value = busy.percent;
        line.append(bar);
      }
      item.append(line);
    }
    const problem = status.error ?? errors.get(browser.id);
    if (problem) item.append(el('p', 'br-error', problem));
    if (!busy && status.verified === false) {
      item.append(
        el(
          'p',
          'br-note',
          'The last download came without a checksum from the vendor to compare it with (it comes from their servers over HTTPS).',
        ),
      );
    }
    return item;
  }

  function streamingSection(next: BrowsersState): HTMLElement {
    const section = el('section', 'br-streaming');
    section.append(el('h2', 'br-section', 'Netflix, Spotify and similar sites'));
    section.append(
      el(
        'p',
        'br-note',
        'These play DRM video and music, which WebKit here cannot. They open in a Chromium browser, in a tab. Chrome and Edge below carry Widevine; Opera does not and Firefox shows its own toolbar, so they are not offered.',
      ),
    );
    const options: [string, string, boolean][] = [
      [
        'system',
        `The Chrome found on this system${next.systemStreamingBrowser ? ` (${next.systemStreamingBrowser})` : ' (none found)'}`,
        next.systemStreamingBrowser !== null,
      ],
      ...(['chrome', 'edge'] as const).map((id): [string, string, boolean] => {
        const status = next.browsers.find((candidate) => candidate.id === id);
        const name = BROWSERS.find((candidate) => candidate.id === id)?.name ?? id;
        const installed = (status?.installed.length ?? 0) > 0;
        return [
          id,
          `${name} installed here${installed ? '' : ' (install it above first)'}`,
          installed,
        ];
      }),
    ];
    for (const [value, text, enabled] of options) {
      const row = el('label', 'br-radio');
      const input = el('input', '');
      input.type = 'radio';
      input.name = 'streaming';
      input.checked = next.streaming === value;
      input.disabled = !enabled;
      input.addEventListener('change', () => {
        void api.browsers.setStreaming(value);
      });
      row.append(input, el('span', '', text));
      section.append(row);
    }
    return section;
  }

  function render(next: BrowsersState): void {
    state = next;
    const banner = el('div', 'br-banner');
    if (next.embedding === 'restart') {
      banner.append(
        el(
          'p',
          'br-banner__text',
          'Webswitch has to restart to show other browsers inside a tab: it runs on X11 for that.',
        ),
      );
      const restart = el('button', 'br-button br-button--primary', 'Restart now');
      restart.addEventListener('click', () => {
        restart.disabled = true;
        void api.settings.restart();
      });
      banner.append(restart);
    } else if (next.embedding === 'off') {
      banner.append(
        el(
          'p',
          'br-banner__text',
          'Showing other browsers inside a tab is switched off: turn on "Show other browsers inside the tab" in General settings.',
        ),
      );
    } else {
      banner.hidden = true;
    }

    const header = el('header', 'br-header');
    header.append(el('h1', 'br-title', 'Test in other browsers'));
    const check = el('button', 'br-button', 'Check for updates');
    check.title = 'Ask each vendor which releases exist';
    const checking = next.browsers.some((browser) => browser.busy?.phase === 'listing');
    check.disabled = checking;
    check.textContent = checking ? 'Checking…' : 'Check for updates';
    check.addEventListener('click', () => {
      void api.browsers.check();
    });
    header.append(check);

    const intro = el(
      'p',
      'br-note',
      `Install the base of other browsers, then open the page you are on in them from the ⋮ menu, inside a tab, to see how it behaves there. Each browser starts with a clean profile that is deleted when the tab closes. They use ${size(next.totalBytes)} on disk now. Installing and checking for updates are the only things here that use the network, and only when you press them; the browsers themselves, once running, do their own network requests.`,
    );

    const cards = (tier: 'main' | 'extra'): HTMLElement => {
      const list = el('ul', 'br-list');
      for (const browser of BROWSERS.filter((candidate) => candidate.tier === tier)) {
        const status = next.browsers.find((candidate) => candidate.id === browser.id);
        if (status) list.append(card(browser, status));
      }
      return list;
    };

    const notes = el('section', 'br-others');
    notes.append(el('h2', 'br-section', 'Not available'));
    notes.append(
      el(
        'p',
        'br-note',
        'Safari only exists on Apple systems; WebKit above is the same family and the closest you can get on Linux. Internet Explorer cannot run on Linux and was retired by Microsoft in 2022; Edge has an IE mode only on Windows.',
      ),
    );

    root.replaceChildren(
      header,
      banner,
      intro,
      cards('main'),
      el('h2', 'br-section', 'Extras'),
      el('p', 'br-note', 'Same engine as Chrome, different defaults, features and release dates.'),
      cards('extra'),
      streamingSection(next),
      notes,
    );
    // The icon of a browser that is not installed was clicked in the menu: show its card.
    if (next.focus && next.focus.n !== handledFocus && Date.now() - next.focus.at < 5000) {
      handledFocus = next.focus.n;
      const card = root.querySelector<HTMLElement>(`.br-card[data-browser="${next.focus.id}"]`);
      if (card) {
        card.dataset.focus = 'true';
        requestAnimationFrame(() => {
          card.scrollIntoView({ block: 'center' });
        });
        setTimeout(() => {
          delete card.dataset.focus;
        }, 2500);
      }
    }
  }

  api.browsers.onChanged(render);
  void api.browsers.get().then(render);

  return { root, show: () => undefined, hide: () => undefined };
}
