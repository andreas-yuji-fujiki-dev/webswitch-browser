import type { ShortcutActionId } from './keybindings';

export interface ShortcutActions extends Record<ShortcutActionId, () => void> {
  /** Ctrl+1 .. Ctrl+8. `position` is 1-based. */
  activateTabAt: (position: number) => void;
}
