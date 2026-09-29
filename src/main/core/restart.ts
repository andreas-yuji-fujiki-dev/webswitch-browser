import GLib from 'gi://GLib?version=2.0';
import type Gtk from 'gi://Gtk?version=4.0';
import { debug } from './debug';

let originalEnvironment: string[] = [];

/**
 * Remembers the environment the browser was started with. `runBrowser` changes some variables
 * itself (GDK_BACKEND, the GPU ones); a restarted browser must start from the original ones, or a
 * setting turned off would still be in force through the variables the old run had set.
 */
export function captureEnvironment(): void {
  originalEnvironment = GLib.get_environ();
}

/** The command this process was started with (`gjs -m dist/main.js ...`), or [] when unknown. */
function ownCommandLine(): string[] {
  try {
    const [, bytes] = GLib.file_get_contents('/proc/self/cmdline');
    return new TextDecoder()
      .decode(bytes)
      .split('\0')
      .filter((part) => part !== '');
  } catch {
    return [];
  }
}

/**
 * The command that starts the browser again: everything up to and including `main.js`, then the
 * addresses to reopen. Addresses the browser was started with are dropped in favor of those.
 */
export function relaunchCommand(commandLine: string[], urls: string[]): string[] {
  if (commandLine.length === 0) return [];
  const entry = commandLine.findIndex((part) => /(^|\/)main\.js$/.test(part));
  return [...(entry >= 0 ? commandLine.slice(0, entry + 1) : commandLine), ...urls];
}

/**
 * Starts the browser again once this process is gone, then quits. The new one is started by a
 * shell that waits for this process to exit: the browser is a single-instance application, so a
 * new one started earlier would just hand its addresses to this one and exit.
 */
export function restartBrowser(app: Gtk.Application, urls: string[]): boolean {
  const command = relaunchCommand(ownCommandLine(), urls);
  if (command.length === 0) return false;
  const pid = GLib.file_read_link('/proc/self');
  const script =
    'i=0; while kill -0 "$0" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i+1)); done; exec "$@"';
  try {
    GLib.spawn_async(
      null,
      ['/bin/sh', '-c', script, pid, ...command],
      originalEnvironment,
      GLib.SpawnFlags.DEFAULT,
      null,
    );
  } catch (error) {
    debug('restart', `could not start the new browser: ${String(error)}`);
    return false;
  }
  debug('restart', `restarting with: ${command.join(' ')}`);
  app.quit();
  return true;
}
