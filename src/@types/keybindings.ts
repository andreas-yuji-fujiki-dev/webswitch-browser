import type { SHORTCUT_ACTIONS } from '~shared/shortcut-actions';

export type ShortcutActionId = keyof typeof SHORTCUT_ACTIONS;

/** The accelerators currently bound to each action, defaults and user overrides merged. */
export type KeybindingsState = Record<ShortcutActionId, string[]>;

/** What keybindings.json stores: only the actions the user changed. */
export type KeybindingOverrides = Partial<Record<ShortcutActionId, string[]>>;

export type KeybindingResult = { ok: true } | { ok: false; error: string };
