import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import { USER_CSS_DEBOUNCE_MS, USER_CSS_FILENAME } from '../../core/config';
import { readText, writeTextIfMissing } from '../../core/files';
import { configDir } from '../../core/paths';
import type { Unsubscribe } from '~types/common';
import defaultUserCss from './user.example.css?raw';

/** Owns `~/.config/webswitch/user.css`: creates it on first run, reads it and reports changes. */
export class UserCssService {
  readonly filePath = GLib.build_filenamev([configDir(), USER_CSS_FILENAME]);
  private readonly listeners = new Set<(css: string) => void>();
  private monitor: Gio.FileMonitor | null = null;
  private debounce: number | null = null;

  async init(): Promise<void> {
    await writeTextIfMissing(this.filePath, defaultUserCss);
    this.watch();
  }

  async read(): Promise<string> {
    return (await readText(this.filePath)) ?? '';
  }

  onChanged(listener: (css: string) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.monitor?.cancel();
    this.monitor = null;
    if (this.debounce !== null) GLib.source_remove(this.debounce);
  }

  // Watches the folder, not the file: many editors save by replacing the file, which would detach
  // a watch on the old file.
  private watch(): void {
    this.monitor = Gio.File.new_for_path(GLib.path_get_dirname(this.filePath)).monitor_directory(
      Gio.FileMonitorFlags.NONE,
      null,
    );
    this.monitor.connect('changed', (_monitor, file) => {
      if (file.get_basename() === USER_CSS_FILENAME) this.scheduleReload();
    });
  }

  private scheduleReload(): void {
    if (this.debounce !== null) GLib.source_remove(this.debounce);
    this.debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, USER_CSS_DEBOUNCE_MS, () => {
      this.debounce = null;
      void this.read().then((css) => {
        for (const listener of this.listeners) listener(css);
      });
      return GLib.SOURCE_REMOVE;
    });
  }
}
