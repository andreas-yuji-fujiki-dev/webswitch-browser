import GLib from 'gi://GLib?version=2.0';
import { validateAccelerator } from '~shared/accelerator';
import { SHORTCUT_ACTIONS } from '~shared/shortcut-actions';
import { KEYBINDINGS_FILENAME } from '../../core/config';
import { readText, writeText } from '../../core/files';
import { configDir } from '../../core/paths';
import type { Unsubscribe } from '~types/common';
import type {
  KeybindingOverrides,
  KeybindingResult,
  KeybindingsState,
  ShortcutActionId,
} from '~types/keybindings';

const ACTION_IDS = Object.keys(SHORTCUT_ACTIONS) as ShortcutActionId[];

function isActionId(value: string): value is ShortcutActionId {
  return value in SHORTCUT_ACTIONS;
}

/**
 * The single source of truth for which keys trigger which action. Defaults come from
 * SHORTCUT_ACTIONS; what the user changes is stored in `~/.config/webswitch/keybindings.json`.
 */
export class KeybindingsService {
  readonly filePath = GLib.build_filenamev([configDir(), KEYBINDINGS_FILENAME]);
  private overrides: KeybindingOverrides = {};
  private readonly listeners = new Set<(state: KeybindingsState) => void>();
  private writeQueue: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    this.overrides = await this.readOverrides();
    this.emit();
  }

  getState(): KeybindingsState {
    const state = {} as KeybindingsState;
    for (const id of ACTION_IDS) {
      state[id] = [...(this.overrides[id] ?? SHORTCUT_ACTIONS[id].defaults)];
    }
    return state;
  }

  onChanged(listener: (state: KeybindingsState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(actionId: ShortcutActionId, accelerators: string[]): KeybindingResult {
    if (!isActionId(actionId) || !Array.isArray(accelerators)) {
      return { ok: false, error: 'Unknown action.' };
    }
    const unique = [...new Set(accelerators)];
    for (const accelerator of unique) {
      const error = typeof accelerator === 'string' ? validateAccelerator(accelerator) : 'Invalid.';
      if (error) return { ok: false, error };
    }

    const state = this.getState();
    for (const other of ACTION_IDS) {
      if (other === actionId) continue;
      const clash = unique.find((accelerator) => state[other].includes(accelerator));
      if (clash) {
        return {
          ok: false,
          error: `${clash} is already used by "${SHORTCUT_ACTIONS[other].label}".`,
        };
      }
    }

    const defaults: readonly string[] = SHORTCUT_ACTIONS[actionId].defaults;
    if (unique.length === defaults.length && unique.every((a, i) => a === defaults[i])) {
      this.overrides = this.withoutOverride(actionId);
    } else {
      this.overrides[actionId] = unique;
    }
    this.commit();
    return { ok: true };
  }

  reset(actionId: ShortcutActionId): void {
    if (!isActionId(actionId)) return;
    this.overrides = this.withoutOverride(actionId);
    this.commit();
  }

  resetAll(): void {
    this.overrides = {};
    this.commit();
  }

  private withoutOverride(actionId: ShortcutActionId): KeybindingOverrides {
    return Object.fromEntries(Object.entries(this.overrides).filter(([id]) => id !== actionId));
  }

  private commit(): void {
    this.emit();
    const json = `${JSON.stringify(this.overrides, null, 2)}\n`;
    // Writes are chained so two quick edits can never land out of order.
    this.writeQueue = this.writeQueue
      .then(() => writeText(this.filePath, json))
      .catch(() => undefined);
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  /** Reads keybindings.json, keeping only entries that are valid. A broken file means defaults. */
  private async readOverrides(): Promise<KeybindingOverrides> {
    const text = await readText(this.filePath);
    if (text === null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {};
    }
    if (typeof parsed !== 'object' || parsed === null) return {};

    const overrides: KeybindingOverrides = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!isActionId(id) || !Array.isArray(value)) continue;
      overrides[id] = value.filter(
        (item): item is string => typeof item === 'string' && validateAccelerator(item) === null,
      );
    }
    return overrides;
  }
}
