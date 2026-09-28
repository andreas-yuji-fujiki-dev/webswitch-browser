import { DEVTOOLS_PROVIDERS } from '~shared/devtools-catalog';
import { compareVersions } from '~shared/version';
import type { BrowserApi } from '~types/browser-api';
import type { DevToolsProviderId, DevToolsResult, DevToolsState } from '~types/devtools';
import type { BuiltInPage, DevToolsRow } from '~types/ui';
import { el } from '../../core/dom';

const LOCATION_LABELS = { app: 'Comes with Webswitch', downloaded: 'Downloaded' };
const LATEST = 'latest';

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The Dev settings page. For now one category, Developer tools: which ones F12 opens, and the ones
 * Chrome DevTools, which comes with the app and can be updated, switched to another release (older
 * ones too) or uninstalled. The main process owns the state;
 * this only shows it and sends the clicks. Nothing is asked from the network until a button says so.
 */
export function createDevSettingsPage(api: BrowserApi): BuiltInPage {
  const root = el('section', 'dev-page');
  const errors = new Map<DevToolsProviderId, string>();
  let last: DevToolsState | null = null;

  root.append(el('h1', 'dev-title', 'Dev settings'));
  const category = el('section', 'dev-section');
  const head = el('div', 'dev-section__head');
  head.append(el('h2', 'dev-section__title', 'Developer tools'));
  const check = el('button', 'dev-button', 'Check for updates');
  check.title = 'Ask the npm registry which releases exist';
  check.addEventListener('click', () => {
    void api.devtools.check();
  });
  head.append(check);
  const current = el('p', 'dev-current');
  const registry = el('p', 'dev-note dev-registry');
  const list = el('ul', 'dev-list');
  category.append(
    head,
    current,
    registry,
    el(
      'p',
      'dev-note',
      'F12 and Ctrl+Shift+I open the one in use. Checking for updates and downloading are the only things on this page that go to the network, and only when you press their buttons.',
    ),
    list,
  );
  root.append(category);

  async function run(id: DevToolsProviderId, action: Promise<DevToolsResult>): Promise<void> {
    const result = await action;
    if (result.ok) errors.delete(id);
    else errors.set(id, result.error);
    if (last) update(last);
  }

  const rows: DevToolsRow[] = DEVTOOLS_PROVIDERS.map((provider) => {
    const row = el('li', 'dev-row');
    const text = el('div', 'dev-text');
    const heading = el('div', 'dev-heading');
    const name = el('span', 'dev-name', provider.name);
    const badge = el('span', 'dev-badge');
    heading.append(name, badge);
    const description = el('p', 'dev-description', provider.description);
    const meta = el('p', 'dev-meta');
    const error = el('p', 'dev-error');
    const bar = el('progress', 'dev-progress');
    bar.max = 100;
    text.append(heading, description, meta, bar, error);

    const use = el('button', 'dev-button dev-button--primary', 'Use');
    use.addEventListener('click', () => {
      void run(provider.id, api.devtools.use(provider.id));
    });

    // The release to install (downloadable ones only): the newest, or one from the last check.
    const versions = el('select', 'dev-versions');
    versions.setAttribute('aria-label', 'Release');
    let listed = '';
    const install = el('button', 'dev-button dev-button--primary');
    let installTarget: string | undefined;
    install.addEventListener('click', () => {
      errors.delete(provider.id);
      void run(provider.id, api.devtools.download(provider.id, installTarget));
    });
    const uninstall = el('button', 'dev-button', 'Uninstall');
    uninstall.title = 'Delete the downloaded files to free the disk space';
    uninstall.addEventListener('click', () => {
      void run(provider.id, api.devtools.uninstall(provider.id));
    });
    const actions = el('div', 'dev-actions');
    actions.append(use, versions, install, uninstall);
    row.append(text, actions);
    list.append(row);

    return {
      id: provider.id,
      update: (state) => {
        const status = state.providers.find((candidate) => candidate.id === provider.id);
        if (!status) return;
        const inUse = state.active === provider.id;
        const busy = status.busy !== null;
        const downloadable = provider.source === 'download';
        row.dataset.active = String(inUse);
        badge.textContent = status.updateAvailable
          ? 'Update available'
          : inUse
            ? 'In use'
            : status.installed
              ? 'Installed'
              : 'Not installed';
        badge.dataset.update = String(status.updateAvailable);

        const parts: string[] = [
          status.location
            ? LOCATION_LABELS[status.location]
            : provider.source === 'builtin'
              ? 'Built in'
              : 'Not installed',
        ];
        if (status.version) parts.push(`version ${status.version}`);
        if (status.installed && status.sizeBytes !== null) {
          parts.push(`${megabytes(status.sizeBytes)} on disk`);
        }
        const newer = state.registry.latest;
        meta.textContent = parts.join(' · ');

        bar.hidden = status.busy !== 'downloading';
        bar.value = status.percent ?? 0;
        const message = status.error ?? errors.get(provider.id);
        error.hidden = !message;
        error.textContent = message ?? '';
        use.hidden = !status.installed || inUse;
        use.disabled = busy;

        versions.hidden = !downloadable || busy;
        install.hidden = true;
        uninstall.hidden = !downloadable || !status.installed || busy;
        if (downloadable) {
          const wanted = `${LATEST}|${state.registry.versions.join(',')}`;
          if (wanted !== listed) {
            const keep = versions.value || LATEST;
            listed = wanted;
            versions.replaceChildren(
              ...[LATEST, ...state.registry.versions].map((value) => {
                const option = el(
                  'option',
                  '',
                  value === LATEST ? (newer ? `Latest (${newer})` : 'Latest') : value,
                );
                option.value = value;
                return option;
              }),
            );
            versions.value = [...versions.options].some((option) => option.value === keep)
              ? keep
              : LATEST;
          }
          const chosen = versions.value === LATEST ? newer : versions.value;
          installTarget = versions.value === LATEST ? undefined : versions.value;
          if (!busy) {
            if (!status.installed) {
              install.hidden = false;
              install.textContent = chosen ? `Install ${chosen}` : 'Install latest';
            } else if (chosen && status.version && chosen !== status.version) {
              install.hidden = false;
              installTarget = chosen;
              install.textContent = `${
                compareVersions(chosen, status.version) > 0 ? 'Update' : 'Switch'
              } to ${chosen}`;
            }
          }
        }
      },
    };
  });

  // Picking another release only changes what the button offers.
  list.addEventListener('change', () => {
    if (last) update(last);
  });

  function update(state: DevToolsState): void {
    last = state;
    const active = DEVTOOLS_PROVIDERS.find((provider) => provider.id === state.active);
    current.textContent = `In use: ${active?.name ?? state.active}`;
    check.disabled = state.registry.checking;
    check.textContent = state.registry.checking ? 'Checking…' : 'Check for updates';
    if (state.registry.error) registry.textContent = `Could not check: ${state.registry.error}`;
    else if (state.registry.latest) {
      const downloaded = state.providers.find((provider) => provider.updateAvailable);
      const count = `${state.registry.versions.length} releases to choose from, older ones too.`;
      registry.textContent = downloaded
        ? `Newest release: ${state.registry.latest}. A newer release than yours is available. ${count}`
        : `Newest release: ${state.registry.latest}. ${count}`;
    } else {
      registry.textContent =
        'Not checked yet. Press Check for updates to list every release, then pick any of them (older ones too) in the downloaded copy below.';
    }
    for (const row of rows) row.update(state);
  }

  api.devtools.onChanged(update);
  void api.devtools.get().then(update);

  return { root, show: () => undefined, hide: () => undefined };
}
