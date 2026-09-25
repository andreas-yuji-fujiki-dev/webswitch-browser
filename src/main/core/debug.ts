import GLib from 'gi://GLib?version=2.0';

/** WEBSWITCH_DEBUG=1: verbose logging of what pages and the engine do, for chasing site bugs. */
export const DEBUG = GLib.getenv('WEBSWITCH_DEBUG') === '1';

/** One log line, "[ws] <tag> <message>", only when debugging. */
export function debug(tag: string, message: string): void {
  if (DEBUG) console.log(`[ws] ${tag} ${message}`);
}
