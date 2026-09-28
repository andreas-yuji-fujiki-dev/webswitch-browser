import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Soup.Session.prototype, 'send_async', 'send_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype, 'close_async', 'close_finish');

const CHUNK = 256 * 1024;

/** Requests a user asked for (a listing, a download); the browser makes no others on its own. */
export class Http {
  private readonly session = new Soup.Session({ timeout: 60 });

  /** The proxy an extension chose applies to the requests the browser makes for extensions too; null: the system's. */
  useProxy(resolver: Gio.ProxyResolver | null): void {
    this.session.proxy_resolver = resolver ?? Gio.ProxyResolver.get_default();
  }

  /** The whole answer, up to `limit` bytes. */
  async bytes(url: string, limit: number): Promise<Uint8Array> {
    const message = this.message(url);
    const answer = await this.session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    this.check(message);
    const data = answer.toArray();
    if (data.length > limit) throw new Error('The answer is bigger than expected.');
    return data;
  }

  async text(url: string, limit: number): Promise<string> {
    return new TextDecoder().decode(await this.bytes(url, limit));
  }

  async json<T>(url: string, limit: number): Promise<T> {
    return JSON.parse(await this.text(url, limit)) as T;
  }

  /** Any request, for what an extension asks the browser to fetch for it. */
  async request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Uint8Array | null,
    limit: number,
  ): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: Uint8Array;
  }> {
    const message = Soup.Message.new(method, url);
    if (message === null) throw new Error('Bad address.');
    const sending = message.get_request_headers();
    for (const [name, value] of Object.entries(headers)) {
      // The browser adds these itself; a page-made request never sets them.
      if (/^(host|cookie|content-length|connection|origin|referer)$/i.test(name)) continue;
      sending.replace(name, value);
    }
    if (body !== null) {
      message.set_request_body_from_bytes(
        headers['content-type'] ?? headers['Content-Type'] ?? null,
        new GLib.Bytes(body),
      );
    }
    const answer = await this.session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    const data = answer.toArray();
    if (data.length > limit) throw new Error('The answer is bigger than allowed.');
    const received: Record<string, string> = {};
    message.get_response_headers().foreach((name, value) => {
      received[name] = value;
    });
    return {
      status: message.get_status(),
      statusText: message.get_reason_phrase() ?? '',
      headers: received,
      body: data,
    };
  }

  /** The status of a HEAD request (to know whether a file exists before downloading it). */
  async exists(url: string): Promise<boolean> {
    const message = Soup.Message.new('HEAD', url);
    if (message === null) return false;
    try {
      await this.session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    } catch {
      return false;
    }
    return message.get_status() === Soup.Status.OK;
  }

  /**
   * Streams a file to disk (some are hundreds of megabytes) and returns its SHA-256 as hex, worked
   * out while it arrives, so the caller can check it against what the vendor published.
   */
  async download(
    url: string,
    path: string,
    limit: number,
    onProgress: (fraction: number) => void,
  ): Promise<string> {
    const message = this.message(url);
    const stream = await this.session.send_async(message, GLib.PRIORITY_DEFAULT, null);
    this.check(message);
    const total = message.get_response_headers().get_content_length();
    if (total > limit) throw new Error('The file is bigger than expected.');
    const sum = GLib.Checksum.new(GLib.ChecksumType.SHA256);
    const file = Gio.File.new_for_path(path);
    const out = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    let received = 0;
    try {
      for (;;) {
        const chunk = await stream.read_bytes_async(CHUNK, GLib.PRIORITY_DEFAULT, null);
        const size = chunk.get_size();
        if (size === 0) break;
        received += size;
        if (received > limit) throw new Error('The file is bigger than expected.');
        sum.update(chunk.toArray());
        out.write_bytes(chunk, null);
        if (total > 0) onProgress(Math.min(1, received / total));
      }
      out.close(null);
    } catch (error) {
      out.close(null);
      file.delete(null);
      throw error;
    } finally {
      await stream.close_async(GLib.PRIORITY_DEFAULT, null);
    }
    return sum.get_string();
  }

  private message(url: string): Soup.Message {
    const message = Soup.Message.new('GET', url);
    if (message === null) throw new Error('Bad address.');
    return message;
  }

  private check(message: Soup.Message): void {
    if (message.get_status() !== Soup.Status.OK) {
      throw new Error(`The server answered ${message.get_status()}.`);
    }
  }
}
