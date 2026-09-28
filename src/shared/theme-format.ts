import type { ThemeColors, ThemeDefinition, ThemeFileInput, ThemeScheme } from '~types/themes';

/** The colors a theme sets, in the order the Themes page lists them. */
export const THEME_COLOR_KEYS = [
  'bg',
  'raised',
  'hover',
  'border',
  'fg',
  'fgStrong',
  'fgSoft',
  'fgMuted',
  'accent',
  'info',
  'success',
  'danger',
] as const satisfies readonly (keyof ThemeColors)[];

const REQUIRED = ['bg', 'fg', 'accent'] as const;
const MAX_NAME = 40;
const MAX_AUTHOR = 60;

/** "#abc" or "#aabbcc" (any case) to "#aabbcc"; null for anything else. Nothing else is ever put in CSS. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/.test(text) ? text : null;
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

/** `amount` of `b` mixed into `a` (0..1). */
export function mix(a: string, b: string, amount: number): string {
  const from = channels(a);
  const to = channels(b);
  return `#${from
    .map((channel, index) =>
      Math.round(channel + ((to[index] ?? 0) - channel) * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** Perceived brightness, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

const SLUG_MAX = 32;

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);
  return slug === '' ? 'theme' : slug;
}

/**
 * Turns what a theme file holds into a theme, or says what is wrong with it. `bg`, `fg` and
 * `accent` are required; the rest are worked out from them when missing, so a small file is enough.
 * Only `#rgb` and `#rrggbb` are accepted as colors, which is what keeps a theme from injecting CSS.
 */
export function parseTheme(
  input: unknown,
  id: string,
): { ok: true; theme: ThemeDefinition } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'A theme is a JSON object with a name and colors.' };
  }
  const file = input as ThemeFileInput;
  const name = typeof file.name === 'string' ? file.name.trim() : '';
  if (name === '' || name.length > MAX_NAME) {
    return { ok: false, error: `The theme needs a "name" of 1 to ${MAX_NAME} characters.` };
  }
  if (
    file.author !== undefined &&
    (typeof file.author !== 'string' || file.author.length > MAX_AUTHOR)
  ) {
    return { ok: false, error: `"author" must be text of at most ${MAX_AUTHOR} characters.` };
  }
  const given: unknown = file.colors;
  if (typeof given !== 'object' || given === null) {
    return { ok: false, error: 'The theme needs a "colors" object.' };
  }
  const clean: Partial<ThemeColors> = {};
  for (const key of THEME_COLOR_KEYS) {
    const raw = (given as Partial<Record<string, unknown>>)[key];
    if (raw === undefined) continue;
    const hex = normalizeHex(raw);
    if (hex === null) return { ok: false, error: `"${key}" must be a color like #1a2b3c.` };
    clean[key] = hex;
  }
  for (const key of REQUIRED) {
    if (clean[key] === undefined) return { ok: false, error: `"colors.${key}" is required.` };
  }
  const bg = clean.bg ?? '#000000';
  const fg = clean.fg ?? '#ffffff';
  const accent = clean.accent ?? '#ffffff';
  let scheme: ThemeScheme = luminance(bg) < 0.5 ? 'dark' : 'light';
  if (file.scheme !== undefined) {
    if (file.scheme !== 'dark' && file.scheme !== 'light') {
      return { ok: false, error: '"scheme" must be "dark" or "light".' };
    }
    scheme = file.scheme;
  }
  const dark = scheme === 'dark';
  const colors: ThemeColors = {
    bg,
    raised: clean.raised ?? mix(bg, fg, dark ? 0.08 : 0.06),
    hover: clean.hover ?? mix(bg, fg, dark ? 0.14 : 0.12),
    border: clean.border ?? mix(bg, fg, dark ? 0.2 : 0.2),
    fg,
    fgStrong: clean.fgStrong ?? mix(fg, dark ? '#ffffff' : '#000000', 0.5),
    fgSoft: clean.fgSoft ?? mix(fg, bg, 0.2),
    fgMuted: clean.fgMuted ?? mix(fg, bg, 0.55),
    accent,
    info: clean.info ?? (dark ? '#63afc5' : '#409cb9'),
    success: clean.success ?? (dark ? '#8bc98d' : '#4f8a5b'),
    danger: clean.danger ?? accent,
  };
  const author =
    typeof file.author === 'string' && file.author.trim() !== '' ? file.author.trim() : undefined;
  const license =
    typeof file.license === 'string' && file.license.trim() !== ''
      ? file.license.trim().slice(0, 60)
      : undefined;
  const source =
    typeof file.source === 'string' && /^[A-Za-z0-9:._/-]{1,120}$/.test(file.source)
      ? file.source
      : undefined;
  return {
    ok: true,
    theme: {
      id,
      name,
      ...(author ? { author } : {}),
      ...(license ? { license } : {}),
      ...(source ? { source } : {}),
      scheme,
      colors,
    },
  };
}

/**
 * The CSS custom properties of a theme, in the same names as `tokens.css`, so they override it.
 * Every value is a validated hex color, so this is safe to serve as a stylesheet.
 */
export function themeCss(theme: ThemeDefinition): string {
  const c = theme.colors;
  const rows: [string, string][] = [
    ['--color-strip', c.bg],
    ['--color-bg', c.bg],
    ['--color-surface', c.bg],
    ['--color-surface-raised', c.raised],
    ['--color-surface-hover', c.hover],
    ['--color-input-bg', c.bg],
    ['--color-tab-bg', c.bg],
    ['--color-border', c.border],
    ['--color-fg', c.fg],
    ['--color-fg-strong', c.fgStrong],
    ['--color-fg-soft', c.fgSoft],
    ['--color-fg-muted', c.fgMuted],
    ['--color-accent', c.accent],
    ['--color-info', c.info],
    ['--color-success', c.success],
    ['--color-danger', c.danger],
    ['--color-brand', c.accent],
    ['--color-selection-bg', c.accent],
    ['--color-selection-fg', c.bg],
  ];
  return `:root {\n  color-scheme: ${theme.scheme};\n${rows.map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}\n`;
}
