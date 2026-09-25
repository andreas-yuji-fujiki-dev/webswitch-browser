import type { BrowserApi } from '~types/browser-api';
import type { TabState } from '~types/tabs';
import type { StateView } from '~types/ui';
import { el } from '../../core/dom';
import { icon } from '../../core/icons';

export function createAddressBar(container: HTMLElement, api: BrowserApi): StateView {
  const back = el('button', 'nav-button');
  back.append(icon('back'));
  back.title = 'Back (Alt+←)';
  back.setAttribute('aria-label', 'Back');
  const forward = el('button', 'nav-button');
  forward.append(icon('forward'));
  forward.title = 'Forward (Alt+→)';
  forward.setAttribute('aria-label', 'Forward');
  const reload = el('button', 'nav-button');
  const input = el('input', 'address-input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.placeholder = 'Search or enter address';
  input.setAttribute('aria-label', 'Address');
  const loadingBar = el('div', 'loading-bar');
  container.append(back, forward, reload, input, loadingBar);

  let active: TabState | undefined;
  let activeId: number | null = null;
  let editing = false;
  let submitted = false;

  back.addEventListener('click', () => {
    void api.navigation.goBack();
  });
  forward.addEventListener('click', () => {
    void api.navigation.goForward();
  });
  reload.addEventListener('click', () => {
    void (active?.loading ? api.navigation.stop() : api.navigation.reload());
  });

  input.addEventListener('focus', () => {
    input.select();
  });
  input.addEventListener('input', () => {
    editing = true;
  });
  input.addEventListener('blur', () => {
    editing = false;
    // After Enter the main process is about to report the new URL; otherwise drop the draft.
    if (!submitted) input.value = active?.url ?? '';
    submitted = false;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      submitted = true;
      editing = false;
      void api.navigation.navigate(input.value);
    } else if (event.key === 'Escape') {
      input.value = active?.url ?? '';
      input.select();
    }
  });

  api.ui.onFocusAddressBar(() => {
    input.focus();
    input.select();
  });

  return {
    render(state) {
      active = state.tabs.find((tab) => tab.id === state.activeTabId);
      const tabChanged = active?.id !== activeId;
      activeId = active?.id ?? null;

      back.disabled = !active?.canGoBack;
      forward.disabled = !active?.canGoForward;
      const loading = active?.loading ?? false;
      reload.replaceChildren(icon(loading ? 'stop' : 'reload'));
      reload.title = loading ? 'Stop' : 'Reload (Ctrl+R)';
      reload.setAttribute('aria-label', loading ? 'Stop' : 'Reload');
      container.dataset.loading = String(loading);

      // Never overwrite what the user is typing, unless they switched tabs.
      if (tabChanged || !editing) input.value = active?.url ?? '';
    },
  };
}
