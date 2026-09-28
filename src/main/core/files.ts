import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

// GJS needs to be told which *_async functions to turn into promises.
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'append_to_async', 'append_to_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'close_async', 'close_finish');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function ensureDir(path: string): void {
  GLib.mkdir_with_parents(path, 0o755);
}

/** The file's text, or null when it does not exist or cannot be read. */
export async function readText(path: string): Promise<string | null> {
  try {
    const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Replaces the file atomically (write to a temporary file, then rename). */
export async function writeText(path: string, text: string): Promise<void> {
  ensureDir(GLib.path_get_dirname(path));
  await Gio.File.new_for_path(path).replace_contents_bytes_async(
    new GLib.Bytes(encoder.encode(text)),
    null,
    false,
    Gio.FileCreateFlags.REPLACE_DESTINATION,
    null,
  );
}

export async function appendText(path: string, text: string): Promise<void> {
  ensureDir(GLib.path_get_dirname(path));
  const stream = await Gio.File.new_for_path(path).append_to_async(
    Gio.FileCreateFlags.NONE,
    GLib.PRIORITY_DEFAULT,
    null,
  );
  // A GLib.Bytes is reference-counted, so the write keeps the data alive. Passing the bare Uint8Array
  // to write_all_async lets the garbage collector free it before the write starts, and the file
  // gets heap garbage (the first 16 bytes of the line) instead of the text.
  await stream.write_bytes_async(new GLib.Bytes(encoder.encode(text)), GLib.PRIORITY_DEFAULT, null);
  await stream.close_async(GLib.PRIORITY_DEFAULT, null);
}

/** Deletes a folder and everything in it (nothing happens when it does not exist). */
export function removeTree(path: string): void {
  const remove = (file: Gio.File): void => {
    const type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (type === Gio.FileType.DIRECTORY) {
      const children = file.enumerate_children(
        'standard::name',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null,
      );
      for (let info = children.next_file(null); info !== null; info = children.next_file(null)) {
        remove(file.get_child(info.get_name()));
      }
      children.close(null);
    }
    file.delete(null);
  };
  const root = Gio.File.new_for_path(path);
  if (root.query_exists(null)) remove(root);
}

/** The size in bytes of everything under `path`. */
export function treeSize(path: string): number {
  const measure = (file: Gio.File): number => {
    const info = file.query_info(
      'standard::type,standard::size',
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      null,
    );
    if (info.get_file_type() !== Gio.FileType.DIRECTORY) return info.get_size();
    let total = 0;
    const children = file.enumerate_children(
      'standard::name',
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      null,
    );
    for (let child = children.next_file(null); child !== null; child = children.next_file(null)) {
      total += measure(file.get_child(child.get_name()));
    }
    children.close(null);
    return total;
  };
  try {
    return measure(Gio.File.new_for_path(path));
  } catch {
    return 0;
  }
}

/** Creates the file with `text` only if it does not exist, so a user's file is never overwritten. */
export async function writeTextIfMissing(path: string, text: string): Promise<void> {
  if (!Gio.File.new_for_path(path).query_exists(null)) await writeText(path, text);
}
