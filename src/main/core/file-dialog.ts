import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');
Gio._promisify(Gtk.FileDialog.prototype, 'select_folder', 'select_folder_finish');

/** Asks the user for a JSON file; its path, or null when they cancel. */
export async function chooseJsonFile(parent: Gtk.Window, title: string): Promise<string | null> {
  const filter = new Gtk.FileFilter();
  filter.set_name('JSON files');
  filter.add_suffix('json');
  const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype });
  filters.append(filter);
  const dialog = new Gtk.FileDialog({ title, filters, default_filter: filter });
  try {
    const file = await dialog.open(parent, null);
    return file.get_path();
  } catch {
    return null; // dismissed
  }
}

/** Asks the user for a folder; its path, or null when they cancel. */
export async function chooseFolder(parent: Gtk.Window, title: string): Promise<string | null> {
  const dialog = new Gtk.FileDialog({ title });
  try {
    const folder = await dialog.select_folder(parent, null);
    return folder.get_path();
  } catch {
    return null; // dismissed
  }
}
