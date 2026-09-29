import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { toAccelerator } from '~shared/accelerator';
import type { KeybindingsState, ShortcutActionId } from '~types/keybindings';
import type { ShortcutActions } from '~types/shortcuts';
import type { KeybindingsService } from '../keybindings/keybindings.service';

// GDK key names that differ from the names used in accelerators (which follow the DOM's).
const KEY_NAMES: Record<string, string> = {
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Page_Up: 'PageUp',
  Page_Down: 'PageDown',
  ISO_Left_Tab: 'Tab',
};
const REPEAT_WINDOW_US = 150_000;

/**
 * Keyboard shortcuts, caught at the window before the focused web view sees the key, so they work
 * whether the focus is in the browser UI or inside a page. Which keys trigger which action comes
 * from KeybindingsService. Native-only: the Keybindings page talks to KeybindingsService.
 */
export class ShortcutsService {
  private lookup = new Map<string, ShortcutActionId>();
  private recording = false;
  private lastAccelerator = '';
  private lastAt = 0;
  /** Shortcuts that extensions asked for; asked when no browser action has the key. */
  private extra: ((accelerator: string, repeated: boolean) => boolean) | null = null;

  constructor(
    private readonly actions: ShortcutActions,
    keybindings: KeybindingsService,
  ) {
    this.rebuild(keybindings.getState());
    keybindings.onChanged((state) => {
      this.rebuild(state);
    });
  }

  setExtraShortcuts(handler: (accelerator: string, repeated: boolean) => boolean): void {
    this.extra = handler;
  }

  /** While the Keybindings page records a new key combination, no shortcut may fire. */
  setRecording(recording: boolean): void {
    this.recording = recording;
  }

  attach(window: Gtk.Window): void {
    const controller = new Gtk.EventControllerKey();
    controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
      const accelerator = this.acceleratorFor(keyval, state);
      return accelerator !== null && this.trigger(accelerator);
    });
    window.add_controller(controller);
  }

  /** Runs the action bound to `accelerator`, if any. Returns whether one ran. */
  trigger(accelerator: string): boolean {
    if (this.recording) return false;

    // A held key repeats; a shortcut fires once per press.
    const now = GLib.get_monotonic_time();
    const repeated = accelerator === this.lastAccelerator && now - this.lastAt < REPEAT_WINDOW_US;
    this.lastAccelerator = accelerator;
    this.lastAt = now;

    // Ctrl+1 .. Ctrl+8 are fixed, like in Chrome.
    const position = /^Ctrl\+([1-8])$/.exec(accelerator)?.[1];
    if (position !== undefined) {
      if (!repeated) this.actions.activateTabAt(Number(position));
      return true;
    }
    const id = this.lookup.get(accelerator);
    if (id === undefined) return this.extra?.(accelerator, repeated) ?? false;
    if (!repeated) this.actions[id]();
    return true;
  }

  private rebuild(state: KeybindingsState): void {
    this.lookup = new Map();
    for (const [id, accelerators] of Object.entries(state) as [ShortcutActionId, string[]][]) {
      for (const accelerator of accelerators) this.lookup.set(accelerator, id);
    }
  }

  private acceleratorFor(keyval: number, state: Gdk.ModifierType): string | null {
    const modifiers = state & Gtk.accelerator_get_default_mod_mask();
    if (modifiers & (Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.META_MASK)) return null;

    const character = Gdk.keyval_to_unicode(keyval);
    const name = Gdk.keyval_name(keyval) ?? '';
    const key =
      character > 0x20 && character !== 0x7f
        ? String.fromCodePoint(character)
        : (KEY_NAMES[name] ?? name);
    return toAccelerator({
      ctrl: (modifiers & Gdk.ModifierType.CONTROL_MASK) !== 0,
      alt: (modifiers & Gdk.ModifierType.ALT_MASK) !== 0,
      shift: (modifiers & Gdk.ModifierType.SHIFT_MASK) !== 0,
      key,
    });
  }
}
