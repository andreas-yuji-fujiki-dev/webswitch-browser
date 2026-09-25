// The canonical text form of a key combination, e.g. "Ctrl+Shift+T" or "Alt+ArrowLeft".
// Used by the main process (matching real key events) and by the Keybindings page (recording
// them), so both sides always agree on what a combination is called.
// No Electron imports: callers pass in a plain description of the key event.

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS']);
const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;
// Ctrl+1 .. Ctrl+8 jump to that tab and cannot be reassigned.
const RESERVED = /^Ctrl\+[1-8]$/;

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

/** Returns null while only a modifier is held (nothing to name yet). */
export function toAccelerator(event: {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}): string | null {
  if (isModifierKey(event.key) || event.key === '') return null;
  const key =
    event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  // Shift is already part of a symbol key ("+" is Shift+"="), so it is only named for letters,
  // digits and named keys such as Tab.
  const isSymbol = event.key.length === 1 && !/[a-z0-9]/i.test(event.key);
  return [
    event.ctrl ? 'Ctrl' : '',
    event.alt ? 'Alt' : '',
    event.shift && !isSymbol ? 'Shift' : '',
    key,
  ]
    .filter(Boolean)
    .join('+');
}

/** Returns an error message, or null when the accelerator may be used as a shortcut. */
export function validateAccelerator(accelerator: string): string | null {
  const match = /^((?:Ctrl\+|Alt\+|Shift\+)*)(.+)$/.exec(accelerator);
  const modifiers = match?.[1] ?? '';
  const key = match?.[2] ?? '';
  if (key === '' || isModifierKey(key)) return 'Press a key together with the modifiers.';
  if (RESERVED.test(accelerator)) return 'Ctrl+1 to Ctrl+8 are reserved for jumping to a tab.';
  // A bare letter would steal typing from every page and from the address bar.
  if (!modifiers.includes('Ctrl+') && !modifiers.includes('Alt+') && !FUNCTION_KEY.test(key)) {
    return 'Use Ctrl or Alt (or a function key F1 to F12).';
  }
  return null;
}
