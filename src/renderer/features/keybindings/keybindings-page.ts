import { isModifierKey, toAccelerator, validateAccelerator } from '~shared/accelerator';
import { SHORTCUT_ACTIONS } from '~shared/shortcut-actions';
import type { BrowserApi } from '~types/browser-api';
import type { KeybindingsState, ShortcutActionId } from '~types/keybindings';
import type { BuiltInPage } from '~types/ui';
import { el } from '../../core/dom';
import { icon } from '../../core/icons';

const ACTION_IDS = Object.keys(SHORTCUT_ACTIONS) as ShortcutActionId[];
const KEY_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};

/** "Ctrl+Shift+T" -> "Ctrl + Shift + T". The key itself may be "+" ("Ctrl++"). */
function display(accelerator: string): string {
  const match = /^((?:Ctrl\+|Alt\+|Shift\+)*)(.+)$/.exec(accelerator);
  const modifiers = (match?.[1] ?? '').split('+').filter(Boolean);
  const key = match?.[2] ?? accelerator;
  return [...modifiers, KEY_LABELS[key] ?? key].join(' + ');
}

function isDefault(id: ShortcutActionId, current: string[]): boolean {
  const defaults: readonly string[] = SHORTCUT_ACTIONS[id].defaults;
  return current.length === defaults.length && current.every((a, i) => a === defaults[i]);
}

/**
 * The Keybindings page: every action with its shortcuts. Click a shortcut to record a new one.
 * The main process owns the data and validates every change; this only shows it and sends edits.
 */
export function createKeybindingsPage(api: BrowserApi): BuiltInPage {
  const root = el('section', 'kb-page');
  let state: KeybindingsState | null = null;
  // `index` is the chip being replaced, or the current list length when adding a new one.
  let recording: { id: ShortcutActionId; index: number } | null = null;
  let error: { id: ShortcutActionId; message: string } | null = null;

  function setRecording(next: typeof recording): void {
    const wasRecording = recording !== null;
    recording = next;
    if (wasRecording !== (next !== null)) void api.keybindings.setRecording(next !== null);
    render();
  }

  async function save(id: ShortcutActionId, accelerators: string[]): Promise<void> {
    const result = await api.keybindings.set(id, accelerators);
    error = result.ok ? null : { id, message: result.error };
    setRecording(null);
  }

  window.addEventListener(
    'keydown',
    (event) => {
      if (!recording || !state) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        error = null;
        setRecording(null);
        return;
      }
      if (isModifierKey(event.key)) return;

      const accelerator = toAccelerator({
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        key: event.key,
      });
      const problem = accelerator === null ? 'Press a key.' : validateAccelerator(accelerator);
      if (accelerator === null || problem !== null) {
        error = { id: recording.id, message: problem ?? 'Press a key.' };
        render();
        return;
      }
      const list = [...state[recording.id]];
      list[recording.index] = accelerator;
      void save(recording.id, list);
    },
    true,
  );
  window.addEventListener('blur', () => {
    if (recording) setRecording(null);
  });

  function renderRow(id: ShortcutActionId, current: string[]): HTMLElement {
    const row = el('li', 'kb-row');
    row.append(el('span', 'kb-label', SHORTCUT_ACTIONS[id].label));

    const chips = el('span', 'kb-chips');
    current.forEach((accelerator, index) => {
      const isRecording = recording?.id === id && recording.index === index;
      const chip = el('span', 'kb-chip');
      chip.dataset.recording = String(isRecording);
      const change = el(
        'button',
        'kb-chip__label',
        isRecording ? 'Press keys…' : display(accelerator),
      );
      change.title = 'Click, then press the new shortcut';
      change.addEventListener('click', () => {
        error = null;
        setRecording({ id, index });
      });
      const remove = el('button', 'kb-chip__remove');
      remove.append(icon('close'));
      remove.title = 'Remove this shortcut';
      remove.setAttribute('aria-label', `Remove ${display(accelerator)}`);
      remove.addEventListener('click', () => {
        error = null;
        void save(
          id,
          current.filter((_, i) => i !== index),
        );
      });
      chip.append(change, remove);
      chips.append(chip);
    });

    const addingHere = recording?.id === id && recording.index === current.length;
    const add = el('button', 'kb-chip kb-chip--add');
    add.dataset.recording = String(addingHere);
    if (addingHere) add.textContent = 'Press keys…';
    else add.append(icon('plus'));
    add.title = 'Add a shortcut';
    add.setAttribute('aria-label', 'Add a shortcut');
    add.addEventListener('click', () => {
      error = null;
      setRecording({ id, index: current.length });
    });
    chips.append(add);
    row.append(chips);

    const reset = el('button', 'kb-reset', 'Reset');
    reset.hidden = isDefault(id, current);
    reset.addEventListener('click', () => {
      error = null;
      void api.keybindings.reset(id);
    });
    row.append(reset);

    if (error?.id === id) row.append(el('p', 'kb-error', error.message));
    return row;
  }

  function render(): void {
    if (!state) return;
    const current = state;
    const header = el('header', 'kb-header');
    header.append(el('h1', 'kb-title', 'Keybindings'));
    const resetAll = el('button', 'kb-reset-all', 'Reset all');
    resetAll.disabled = ACTION_IDS.every((id) => isDefault(id, current[id]));
    resetAll.addEventListener('click', () => {
      error = null;
      void api.keybindings.resetAll();
    });
    header.append(resetAll);

    const list = el('ul', 'kb-list');
    for (const id of ACTION_IDS) list.append(renderRow(id, current[id]));

    root.replaceChildren(
      header,
      el(
        'p',
        'kb-note',
        'Click a shortcut, then press the new keys. Esc cancels. Shortcuts need Ctrl or Alt (or F1–F12). Ctrl+1 to Ctrl+8 always jump to that tab.',
      ),
      list,
    );
  }

  api.keybindings.onChanged((next) => {
    state = next;
    render();
  });
  void api.keybindings.get().then((initial) => {
    state = initial;
    render();
  });

  return {
    root,
    show: () => undefined,
    // Called when the tab stops showing this page, so shortcuts are never left suspended.
    hide: () => {
      if (recording) setRecording(null);
    },
  };
}
