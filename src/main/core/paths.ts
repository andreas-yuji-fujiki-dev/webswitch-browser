import GLib from 'gi://GLib?version=2.0';

/** ~/.config/webswitch: what the user edits (user.css, keybindings.json). */
export function configDir(): string {
  return GLib.build_filenamev([GLib.get_user_config_dir(), 'webswitch']);
}

/** ~/.local/share/webswitch: what the browser keeps (history, cookies, site data). */
export function dataDir(): string {
  return GLib.build_filenamev([GLib.get_user_data_dir(), 'webswitch']);
}

/** ~/.cache/webswitch: disposable. */
export function cacheDir(): string {
  return GLib.build_filenamev([GLib.get_user_cache_dir(), 'webswitch']);
}

/** The folder the built files live in (dist/): every bundle sits next to preload.js and renderer/. */
export function distDir(): string {
  const [path] = GLib.filename_from_uri(import.meta.url);
  return GLib.path_get_dirname(path);
}
