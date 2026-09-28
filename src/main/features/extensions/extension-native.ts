import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import { debug } from '../../core/debug';
import type { HostProcess } from '~types/extensions';

Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');

const HOST_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
/** Chrome's limits: 1 MiB from a host, 64 MiB to it. */
const MAX_FROM_HOST = 1024 * 1024;
const MAX_TO_HOST = 64 * 1024 * 1024;
const CLOSE_GRACE_S = 2;

/** Where programs that Chrome-style extensions may talk to are announced (a JSON file per program). */
function hostFolders(): string[] {
  const config = GLib.get_user_config_dir();
  return [
    GLib.build_filenamev([config, 'webswitch', 'NativeMessagingHosts']),
    GLib.build_filenamev([config, 'google-chrome', 'NativeMessagingHosts']),
    GLib.build_filenamev([config, 'chromium', 'NativeMessagingHosts']),
    GLib.build_filenamev([config, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts']),
    '/etc/opt/chrome/native-messaging-hosts',
    '/etc/chromium/native-messaging-hosts',
    '/usr/lib/chromium/native-messaging-hosts',
    '/usr/lib64/chromium/native-messaging-hosts',
  ];
}

async function readExactly(stream: Gio.InputStream, count: number): Promise<Uint8Array | null> {
  const out = new Uint8Array(count);
  let got = 0;
  while (got < count) {
    const chunk = await stream.read_bytes_async(count - got, GLib.PRIORITY_DEFAULT, null);
    if (chunk.get_size() === 0) return null;
    out.set(chunk.toArray(), got);
    got += chunk.get_size();
  }
  return out;
}

/**
 * Native messaging: an extension talks to a program on this computer, the way Chrome does it. The
 * program announces itself with a JSON file in one of Chrome's own folders (or Webswitch's), naming
 * the extensions that may use it (`allowed_origins`); Webswitch starts it with the extension's
 * address as its argument and passes messages as 4 bytes of length and JSON over its standard input
 * and output. Nothing is started unless the user installed such a program and it names the extension.
 */
export class NativeHosts {
  private readonly hosts = new Map<string, HostProcess>();

  constructor(
    /** A message came from the program. */
    private readonly received: (extension: string, portId: string, message: unknown) => void,
    /** The program ended (or could not be reached); `error` says why when it was not asked to. */
    private readonly ended: (extension: string, portId: string, error: string | null) => void,
  ) {}

  /** The program's path, if a JSON file names this program and lets this extension use it. */
  private locate(extension: string, name: string): string {
    if (!HOST_NAME.test(name)) throw new Error('Invalid native messaging host name.');
    for (const folder of hostFolders()) {
      try {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([folder, `${name}.json`]));
        const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
          name?: string;
          path?: string;
          type?: string;
          allowed_origins?: string[];
        };
        if (manifest.name !== name || manifest.type !== 'stdio') continue;
        if (!(manifest.allowed_origins ?? []).includes(`chrome-extension://${extension}/`)) {
          throw new Error('Access to the specified native messaging host is forbidden.');
        }
        if (typeof manifest.path !== 'string' || !manifest.path.startsWith('/')) continue;
        return manifest.path;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Access')) throw error;
      }
    }
    throw new Error('Specified native messaging host not found.');
  }

  /** Starts the program for a port and begins passing what it says on. */
  connect(extension: string, portId: string, name: string): void {
    const path = this.locate(extension, name);
    const process = Gio.Subprocess.new(
      [path, `chrome-extension://${extension}/`],
      Gio.SubprocessFlags.STDIN_PIPE |
        Gio.SubprocessFlags.STDOUT_PIPE |
        Gio.SubprocessFlags.STDERR_SILENCE,
    );
    const stdin = process.get_stdin_pipe();
    const stdout = process.get_stdout_pipe();
    if (!stdin || !stdout) throw new Error('Native messaging host could not be started.');
    const host: HostProcess = { extension, process, stdin, stdout, closing: false };
    this.hosts.set(portId, host);
    debug('native', `${name}: started ${path}`);
    void this.pump(portId, host);
  }

  async post(extension: string, portId: string, message: unknown): Promise<void> {
    const host = this.hosts.get(portId);
    if (host?.extension !== extension) throw new Error('Native messaging port is closed.');
    const payload = new TextEncoder().encode(JSON.stringify(message));
    if (payload.length > MAX_TO_HOST) throw new Error('Message too large.');
    const frame = new Uint8Array(4 + payload.length);
    new DataView(frame.buffer).setUint32(0, payload.length, true);
    frame.set(payload, 4);
    const bytes = new GLib.Bytes(frame);
    let written = 0;
    while (written < frame.length) {
      const part = GLib.Bytes.new_from_bytes(bytes, written, frame.length - written);
      written += await host.stdin.write_bytes_async(part, GLib.PRIORITY_DEFAULT, null);
    }
  }

  disconnect(extension: string, portId: string): void {
    const host = this.hosts.get(portId);
    if (host?.extension !== extension) return;
    this.close(portId, host);
  }

  /** `runtime.sendNativeMessage`: one message out, one back, then the program is closed. */
  async sendOnce(extension: string, name: string, message: unknown): Promise<unknown> {
    const portId = `once:${String(GLib.get_monotonic_time())}`;
    const answer = new Promise<unknown>((resolve, reject) => {
      this.onceWaiting.set(portId, { resolve, reject });
    });
    try {
      this.connect(extension, portId, name);
      await this.post(extension, portId, message);
      return await answer;
    } finally {
      this.onceWaiting.delete(portId);
      this.disconnect(extension, portId);
    }
  }

  private readonly onceWaiting = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  /** Every program an extension started is closed (the extension was turned off or removed). */
  closeAll(extension: string): void {
    for (const [portId, host] of [...this.hosts])
      if (host.extension === extension) this.close(portId, host);
  }

  private close(portId: string, host: HostProcess): void {
    if (host.closing) return;
    host.closing = true;
    this.hosts.delete(portId);
    try {
      host.stdin.close(null);
    } catch {
      // Already closed.
    }
    // A program that does not leave when its input ends is made to.
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CLOSE_GRACE_S, () => {
      host.process.force_exit();
      return GLib.SOURCE_REMOVE;
    });
  }

  private async pump(portId: string, host: HostProcess): Promise<void> {
    let error: string | null = null;
    try {
      for (;;) {
        const header = await readExactly(host.stdout, 4);
        if (header === null) break;
        const length = new DataView(header.buffer).getUint32(0, true);
        if (length > MAX_FROM_HOST)
          throw new Error('Native host sent a message that is too large.');
        const body = await readExactly(host.stdout, length);
        if (body === null) break;
        const message = JSON.parse(new TextDecoder().decode(body)) as unknown;
        const once = this.onceWaiting.get(portId);
        if (once) once.resolve(message);
        else this.received(host.extension, portId, message);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const wasClosed = host.closing;
    this.close(portId, host);
    const once = this.onceWaiting.get(portId);
    if (once) once.reject(new Error(error ?? 'Native host has exited.'));
    else if (!wasClosed) this.ended(host.extension, portId, error ?? 'Native host has exited.');
  }
}
