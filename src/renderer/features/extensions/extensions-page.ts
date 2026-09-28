import type { BrowserApi } from '~types/browser-api';
import type {
  ExtensionResult,
  ExtensionsState,
  ExtensionSummary,
  InstalledExtension,
} from '~types/extensions';
import type { BuiltInPage } from '~types/ui';
import { el } from '../../core/dom';

const WARNING = [
  'Extensions are off. That is how Webswitch starts: by default nothing tracks you, and nobody else does either.',
  'Extensions change that, if you want them to. An extension you install can read and change every page it is allowed to run on: what you see, what you type, the accounts you are signed in to on those sites. It can keep that and send it to whoever made it. Webswitch cannot see what an extension does with it, and cannot stop it.',
  "Installing one from the Chrome Web Store asks Google's servers for the file, so Google learns which extension you asked for. That is the only thing Webswitch itself sends; the extension's own requests are its business.",
  'Some extensions, such as ad blockers made with Manifest V3 rules, only block requests and never see your pages. Each one lists what it asks for before you add it.',
  'Turn this on only if you accept that. You can turn it off at any time: every extension stops at once and stays installed for when you want it back.',
];

const HOST_TEXT: Record<ExtensionSummary['hostAccess'], string> = {
  all: 'Reads and changes every website you visit.',
  sites: 'Reads and changes only these sites:',
  none: 'Does not run on any website.',
};

/** What an extension asks for, in words: who it can read, what will and will not work here. */
function permissions(extension: ExtensionSummary): HTMLElement {
  const box = el('div', 'ex-permissions');
  const access = el(
    'p',
    `ex-access ex-access--${extension.hostAccess}`,
    HOST_TEXT[extension.hostAccess],
  );
  box.append(access);
  if (extension.hostAccess === 'sites') {
    const list = el('ul', 'ex-hosts');
    for (const host of extension.hosts.slice(0, 12)) list.append(el('li', '', host));
    if (extension.hosts.length > 12)
      list.append(el('li', '', `and ${extension.hosts.length - 12} more`));
    box.append(list);
  }
  const group = (title: string, items: string[], kind: string): void => {
    if (items.length === 0) return;
    const row = el('p', 'ex-chips');
    row.append(el('span', 'ex-chips__title', title));
    for (const item of items) row.append(el('span', `ex-chip ex-chip--${kind}`, item));
    box.append(row);
  };
  group('Works here', extension.supported, 'ok');
  group('Will not work here', extension.unsupported, 'no');
  group('Accepted, does nothing', extension.ignored, 'ignored');
  if (extension.risks.length > 0) {
    const list = el('ul', 'ex-risks');
    for (const risk of extension.risks) list.append(el('li', '', risk));
    box.append(list);
  }
  return box;
}

/**
 * The Extensions page. Until the switch for extensions is turned on (with a warning the user has to
 * accept) it only explains what extensions mean for privacy. After that: install from the Chrome
 * Web Store by address or id, or load a folder; every install waits for the user to read what the
 * extension asks for; installed ones can be turned off, opened in their options, updated or removed.
 * The main process owns the state and checks every request; this shows it and sends the clicks.
 */
export function createExtensionsPage(api: BrowserApi): BuiltInPage {
  const root = el('section', 'ex-page');
  let state: ExtensionsState | null = null;
  let understood = false;
  let message: { text: string; error: boolean } | null = null;
  let removeArmed: string | null = null;
  let removeTimer: number | undefined;
  let draft = '';

  function settle(result: ExtensionResult | null): void {
    if (result === null) return;
    message = result.ok ? null : { text: result.error, error: true };
    if (state) render(state);
  }

  function gate(): HTMLElement {
    const box = el('section', 'ex-gate');
    box.append(el('h2', 'ex-gate__title', 'Before you turn them on'));
    for (const paragraph of WARNING.slice(1)) box.append(el('p', 'ex-text', paragraph));
    const label = el('label', 'ex-understand');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = understood;
    label.append(check, el('span', '', 'I understand that extensions I install may track me.'));
    const turnOn = el('button', 'ex-button ex-button--primary', 'Allow extensions');
    turnOn.disabled = !understood;
    check.addEventListener('change', () => {
      understood = check.checked;
      turnOn.disabled = !understood;
    });
    turnOn.addEventListener('click', () => {
      understood = false;
      void api.settings.set('extensions', true);
    });
    box.append(label, turnOn);
    return box;
  }

  function installPanel(next: ExtensionsState): HTMLElement {
    const box = el('section', 'ex-add');
    box.append(el('h2', 'ex-h2', 'Add an extension'));
    const row = el('div', 'ex-add__row');
    const input = el('input', 'ex-input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = 'Chrome Web Store address, or the 32-letter id';
    input.setAttribute('aria-label', 'Chrome Web Store address or id');
    input.value = draft;
    input.disabled = next.busy !== null;
    input.addEventListener('input', () => {
      draft = input.value;
    });
    const install = el('button', 'ex-button ex-button--primary', 'Get it');
    install.disabled = next.busy !== null;
    const submit = (): void => {
      if (draft.trim() === '') return;
      message = null;
      void api.extensions.prepareStore(draft.trim()).then(settle);
    };
    install.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    const folder = el('button', 'ex-button', 'Load a folder…');
    folder.title = 'For developers: an unpacked extension on disk';
    folder.disabled = next.busy !== null;
    folder.addEventListener('click', () => {
      message = null;
      void api.extensions.chooseFolder().then(settle);
    });
    row.append(input, install, folder);
    box.append(row);
    if (next.busy !== null) box.append(el('p', 'ex-busy', next.busy));
    if (message)
      box.append(el('p', `ex-message${message.error ? ' ex-message--error' : ''}`, message.text));
    return box;
  }

  function pendingCard(pending: ExtensionSummary): HTMLElement {
    const box = el('section', 'ex-pending');
    box.append(el('h2', 'ex-pending__title', `Add “${pending.name}”?`));
    box.append(el('p', 'ex-meta', `Version ${pending.version}`));
    if (pending.description !== '') box.append(el('p', 'ex-text', pending.description));
    box.append(permissions(pending));
    const details: string[] = [];
    if (pending.contentScripts > 0)
      details.push(`${pending.contentScripts} script(s) that run inside pages`);
    if (pending.hasBackground) details.push('a background part that keeps running');
    if (details.length > 0) box.append(el('p', 'ex-text', `It has ${details.join(' and ')}.`));
    const add = el('button', 'ex-button ex-button--primary', 'Add extension');
    add.addEventListener('click', () => {
      void api.extensions.confirm().then(settle);
    });
    const cancel = el('button', 'ex-button', 'Cancel');
    cancel.addEventListener('click', () => {
      void api.extensions.cancel().then(settle);
    });
    const actions = el('div', 'ex-actions');
    actions.append(add, cancel);
    box.append(actions);
    return box;
  }

  function card(extension: InstalledExtension): HTMLElement {
    const item = el('li', 'ex-card');
    item.dataset.enabled = String(extension.enabled);
    const head = el('div', 'ex-head');
    if (extension.icon !== null) {
      const image = el('img', 'ex-icon');
      image.src = extension.icon;
      image.alt = '';
      head.append(image);
    } else {
      head.append(el('span', 'ex-icon ex-icon--letter', extension.name.slice(0, 1).toUpperCase()));
    }
    const title = el('div', 'ex-title');
    title.append(
      el('span', 'ex-name', extension.name),
      el(
        'span',
        'ex-meta',
        `${extension.version} · ${extension.source === 'store' ? 'Chrome Web Store' : 'folder'}`,
      ),
    );
    head.append(title);
    item.append(head);
    if (extension.description !== '') item.append(el('p', 'ex-text', extension.description));
    item.append(permissions(extension));

    const actions = el('div', 'ex-actions');
    const toggle = el('button', 'ex-button', extension.enabled ? 'Turn off' : 'Turn on');
    toggle.addEventListener('click', () => {
      void api.extensions.setEnabled(extension.id, !extension.enabled).then(settle);
    });
    actions.append(toggle);
    if (extension.hasOptions && extension.enabled) {
      const options = el('button', 'ex-button', 'Options');
      options.addEventListener('click', () => {
        void api.extensions.openOptions(extension.id);
      });
      actions.append(options);
    }
    if (extension.source === 'store') {
      const update = el('button', 'ex-button', 'Update');
      update.title = 'Downloads the current version from the Chrome Web Store';
      update.addEventListener('click', () => {
        message = null;
        void api.extensions.prepareStore(extension.id).then(settle);
      });
      actions.append(update);
    }
    const armed = removeArmed === extension.id;
    const remove = el(
      'button',
      'ex-button ex-button--danger',
      armed ? 'Click again to remove' : 'Remove',
    );
    remove.addEventListener('click', () => {
      window.clearTimeout(removeTimer);
      if (!armed) {
        removeArmed = extension.id;
        removeTimer = window.setTimeout(() => {
          removeArmed = null;
          if (state) render(state);
        }, 3000);
        if (state) render(state);
        return;
      }
      removeArmed = null;
      void api.extensions.remove(extension.id).then(settle);
    });
    actions.append(remove);
    item.append(actions);
    return item;
  }

  function render(next: ExtensionsState): void {
    // Typing in the box must survive a redraw caused by something else.
    const typing = root.querySelector<HTMLInputElement>('.ex-input');
    const hadFocus = typing !== null && document.activeElement === typing;
    state = next;
    const header = el('header', 'ex-header');
    header.append(el('h1', 'ex-title-page', 'Extensions'));
    if (next.enabled) {
      const off = el('button', 'ex-button', 'Turn extensions off');
      off.title = 'Every extension stops at once; they stay installed';
      off.addEventListener('click', () => {
        void api.settings.set('extensions', false);
      });
      header.append(off);
    }
    const parts: HTMLElement[] = [header];
    if (next.enabled && next.proxy) {
      const notice = el('section', 'ex-proxy');
      notice.append(
        el('h2', 'ex-proxy__title', `${next.proxy.name} is routing your browsing through a proxy`),
        el('p', 'ex-text', next.proxy.description),
      );
      const stop = el('button', 'ex-button ex-button--danger', 'Stop using this proxy');
      stop.addEventListener('click', () => {
        void api.extensions.clearProxy();
      });
      notice.append(stop);
      parts.push(notice);
    }
    if (!next.enabled) {
      parts.push(el('p', 'ex-lead', WARNING[0]), gate());
    } else {
      parts.push(installPanel(next));
      if (next.pending) parts.push(pendingCard(next.pending));
      parts.push(el('h2', 'ex-h2', `Installed (${next.extensions.length})`));
      if (next.extensions.length === 0) {
        parts.push(el('p', 'ex-note', 'Nothing installed yet.'));
      } else {
        const list = el('ul', 'ex-list');
        list.append(...next.extensions.map(card));
        parts.push(list);
      }
    }
    parts.push(
      el(
        'p',
        'ex-note',
        'Webswitch runs extensions on WebKit, not Chrome: content scripts, styles, popups, options pages, storage, messages, tabs and Manifest V3 blocking rules work; blocking with the older webRequest API (uBlock Origin) does not, and nor do native messaging, WebAuthn keys or anything that needs the Chrome browser itself. Each extension lists what will not work before you add it.',
      ),
    );
    root.replaceChildren(...parts);
    if (hadFocus) root.querySelector<HTMLInputElement>('.ex-input')?.focus();
  }

  api.extensions.onChanged(render);
  void api.extensions.get().then(render);

  return { root, show: () => undefined, hide: () => undefined };
}
