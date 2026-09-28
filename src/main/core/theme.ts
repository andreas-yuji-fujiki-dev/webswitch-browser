import Gtk from 'gi://Gtk?version=4.0';
import { BUILTIN_THEMES, DARK_THEME } from '~shared/themes-catalog';
import type { ThemeColors } from '~types/themes';

/** True when the system asks for a dark interface (GTK follows the desktop's color scheme). */
export function isDark(): boolean {
  const settings = Gtk.Settings.get_default();
  if (!settings) return true;
  switch (settings.gtk_interface_color_scheme) {
    case Gtk.InterfaceColorScheme.DARK:
      return true;
    case Gtk.InterfaceColorScheme.LIGHT:
      return false;
    default:
      return true;
  }
}

/**
 * WebKitGTK answers `prefers-color-scheme` from `gtk-application-prefer-dark-theme` only, not from
 * the desktop's color scheme, so the desktop's choice is copied into it (and kept in step).
 */
export function followSystemColorScheme(): void {
  const settings = Gtk.Settings.get_default();
  if (!settings) return;
  const apply = (): void => {
    // Deprecated, but it is the only switch WebKitGTK reads for `prefers-color-scheme`.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    settings.gtk_application_prefer_dark_theme = isDark();
  };
  apply();
  settings.connect('notify::gtk-interface-color-scheme', apply);
}

let chrome: ThemeColors | null = null;

/** The colors GTK draws itself with (window buttons, the popup frame ...): the active theme's. */
export function setChromeColors(colors: ThemeColors): void {
  chrome = colors;
}

export function chromeColors(): ThemeColors {
  if (chrome) return chrome;
  const wanted = isDark() ? DARK_THEME : 'webswitch-light';
  const theme = BUILTIN_THEMES.find((candidate) => candidate.id === wanted) ?? BUILTIN_THEMES[0];
  if (!theme) throw new Error('No built-in themes');
  return theme.colors;
}
