import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import { HISTORY_FILENAME, KEYBINDINGS_FILENAME, USER_CSS_FILENAME } from './config';
import { readText, writeText } from './files';
import { configDir, dataDir } from './paths';

/**
 * The Electron versions of Webswitch kept everything in ~/.config/Webswitch. On the first run of
 * this version, copy what the user made there (user.css, keybindings, history) to the new places,
 * never overwriting anything that already exists. The old folder is left untouched.
 */
export async function migrateLegacyData(): Promise<void> {
  const legacy = GLib.build_filenamev([GLib.get_user_config_dir(), 'Webswitch']);
  const moves: [name: string, to: string][] = [
    [USER_CSS_FILENAME, configDir()],
    [KEYBINDINGS_FILENAME, configDir()],
    [HISTORY_FILENAME, dataDir()],
  ];
  for (const [name, folder] of moves) {
    const target = GLib.build_filenamev([folder, name]);
    if (Gio.File.new_for_path(target).query_exists(null)) continue;
    const text = await readText(GLib.build_filenamev([legacy, name]));
    if (text !== null) await writeText(target, text);
  }
}
