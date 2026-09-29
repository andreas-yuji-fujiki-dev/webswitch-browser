import { luminance, mix } from './theme-format';
import type { ThemeColors, ThemeFileInput } from '~types/themes';

/**
 * Turns a VS Code color theme (the JSON an extension ships: `colors`, `type`, sometimes an `include`
 * of another file) into what `parseTheme` takes. VS Code themes color an editor, so only the parts
 * that make sense for a browser's chrome are taken: the background, the text, the accent and the
 * status colors; the rest is worked out from those.
 */

/** JSON with comments and trailing commas, which is how most theme files are written. */
export function parseJsonc(raw: string): unknown {
  // A byte order mark in front is not part of the JSON.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next;
        i++;
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  // A comma right before a closing bracket is not JSON either.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa" to [r, g, b, alpha 0..1]; null for anything else. */
function readHex(value: unknown): [number, number, number, number] | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (!/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(text)) return null;
  const digits = text.slice(1);
  const full =
    digits.length <= 4
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits;
  const part = (at: number): number => parseInt(full.slice(at, at + 2), 16);
  return [part(0), part(2), part(4), full.length === 8 ? part(6) / 255 : 1];
}

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

/** A color from the theme as "#rrggbb"; a see-through one is laid over `under` (the background). */
function solid(value: unknown, under: string | null): string | null {
  const parsed = readHex(value);
  if (!parsed) return null;
  const [r, g, b, alpha] = parsed;
  const color = toHex(r, g, b);
  return alpha >= 0.999 || under === null ? color : mix(under, color, alpha);
}

function saturation(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const high = Math.max(r, g, b);
  return high === 0 ? 0 : (high - Math.min(r, g, b)) / high;
}

// Where a browser looks for its main color: the ones VS Code themes use for what stands out.
const ACCENT_KEYS = [
  'activityBarBadge.background',
  'button.background',
  'textLink.foreground',
  'progressBar.background',
  'focusBorder',
  'editorCursor.foreground',
  'terminal.ansiBlue',
  'terminal.ansiMagenta',
  'terminal.ansiCyan',
] as const;

/** A theme file's colors with its `include` chain applied (the file that includes wins). */
export function mergeIncluded(
  files: { colors?: Record<string, unknown>; type?: unknown; name?: unknown }[],
): { colors: Record<string, unknown>; type: unknown; name: unknown } {
  const colors: Record<string, unknown> = {};
  let type: unknown;
  let name: unknown;
  // Parents first, so what the including file says is the last word.
  for (const file of [...files].reverse()) {
    Object.assign(colors, file.colors ?? {});
    if (file.type !== undefined) type = file.type;
    if (file.name !== undefined) name = file.name;
  }
  return { colors, type, name };
}

/**
 * The theme, ready for `parseTheme`. `uiTheme` is what the extension's `package.json` says
 * ("vs-dark", "vs", "hc-black", "hc-light"), used when the file itself has no `type`.
 */
export function convertVsCodeTheme(
  theme: { colors?: Record<string, unknown>; type?: unknown; name?: unknown },
  label: string,
  uiTheme: string | undefined,
): ThemeFileInput {
  const colors = theme.colors ?? {};
  const declared = typeof theme.type === 'string' ? theme.type : (uiTheme ?? '');
  const light = /light|^vs$/.test(declared);
  const bg = solid(colors['editor.background'], null) ?? (light ? '#ffffff' : '#1e1e1e');
  const first = (...keys: string[]): string | null => {
    for (const key of keys) {
      const found = solid(colors[key], bg);
      if (found) return found;
    }
    return null;
  };
  const fg = first('foreground', 'editor.foreground') ?? (light ? '#333333' : '#cccccc');

  // The accent has to be seen against the background and to be a color, not another gray.
  const candidates = ACCENT_KEYS.map((key) => solid(colors[key], bg)).filter(
    (candidate): candidate is string => candidate !== null,
  );
  const visible = candidates.filter(
    (candidate) => Math.abs(luminance(candidate) - luminance(bg)) >= 0.15,
  );
  const accent =
    visible.find((candidate) => saturation(candidate) >= 0.3) ??
    [...visible].sort((a, b) => saturation(b) - saturation(a))[0] ??
    fg;

  const out: Partial<Record<keyof ThemeColors, string>> = { bg, fg, accent };
  const set = (key: keyof ThemeColors, value: string | null): void => {
    if (value !== null && value !== bg) out[key] = value;
  };
  set(
    'raised',
    first('editorWidget.background', 'sideBar.background', 'titleBar.activeBackground'),
  );
  set('hover', first('list.hoverBackground', 'toolbar.hoverBackground'));
  set('border', first('panel.border', 'sideBar.border', 'editorGroup.border', 'contrastBorder'));
  const strong = first('titleBar.activeForeground', 'editor.foreground');
  if (strong !== null && strong !== fg) out.fgStrong = strong;
  const soft = first('sideBar.foreground');
  if (soft !== null && soft !== fg) out.fgSoft = soft;
  // "Muted" text has to be quieter than the text: some themes give the same color for both.
  const muted = first('descriptionForeground', 'editorLineNumber.foreground');
  if (muted !== null && Math.abs(luminance(muted) - luminance(fg)) >= 0.12) out.fgMuted = muted;
  set('info', first('editorInfo.foreground', 'terminal.ansiBlue', 'textLink.foreground'));
  set('success', first('terminal.ansiGreen', 'gitDecoration.addedResourceForeground'));
  set('danger', first('errorForeground', 'editorError.foreground', 'terminal.ansiRed'));

  return {
    name: label || (typeof theme.name === 'string' ? theme.name : ''),
    scheme: light ? 'light' : 'dark',
    colors: out,
  };
}
