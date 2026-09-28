import type { CrxHeader } from '~types/extensions';

/**
 * A Chrome extension is downloaded as a .crx: a small header and then an ordinary zip. This reads
 * the header (CRX3 as the Web Store serves it, and the older CRX2) far enough to know which
 * extension the file claims to be, so the caller can check it is the one that was asked for.
 */

const u32 = (data: Uint8Array, at: number): number =>
  ((data[at] ?? 0) |
    ((data[at + 1] ?? 0) << 8) |
    ((data[at + 2] ?? 0) << 16) |
    ((data[at + 3] ?? 0) << 24)) >>>
  0;

/** The "a".."p" name of an extension: its 16 id bytes as 32 hex digits, 0-f written as a-p. */
export function extensionIdFrom(bytes: Uint8Array): string {
  let id = '';
  for (const byte of bytes.slice(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15));
  }
  return id;
}

/** True for what the Web Store calls an extension id. */
export function isExtensionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-p]{32}$/.test(value);
}

/** Reads one protobuf message as [field, wire type, value] triples (varints and length-delimited). */
function fields(data: Uint8Array): { field: number; bytes: Uint8Array }[] {
  const found: { field: number; bytes: Uint8Array }[] = [];
  let at = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = data[at++];
      if (byte === undefined) throw new Error('The header ends too soon.');
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
  };
  while (at < data.length) {
    const tag = varint();
    const wire = tag & 7;
    const field = Math.floor(tag / 8);
    if (wire === 0) {
      varint();
    } else if (wire === 2) {
      const length = varint();
      if (at + length > data.length) throw new Error('The header ends too soon.');
      found.push({ field, bytes: data.slice(at, at + length) });
      at += length;
    } else if (wire === 1) {
      at += 8;
    } else if (wire === 5) {
      at += 4;
    } else {
      throw new Error('The header has something unexpected in it.');
    }
  }
  return found;
}

/** The header of a .crx, or an error message when it is not one. */
export function parseCrx(
  data: Uint8Array,
): { ok: true; header: CrxHeader } | { ok: false; error: string } {
  try {
    if (
      data.length < 16 ||
      data[0] !== 0x43 ||
      data[1] !== 0x72 ||
      data[2] !== 0x32 ||
      data[3] !== 0x34
    ) {
      return { ok: false, error: 'That is not an extension package.' };
    }
    const version = u32(data, 4);
    if (version === 3) {
      const size = u32(data, 8);
      if (12 + size > data.length) return { ok: false, error: 'The package is cut short.' };
      const publicKeys: Uint8Array[] = [];
      let crxId: Uint8Array | null = null;
      for (const entry of fields(data.slice(12, 12 + size))) {
        // 2: RSA proofs, 3: ECDSA proofs (each holds the public key as field 1), 10000: what was signed.
        if (entry.field === 2 || entry.field === 3) {
          const key = fields(entry.bytes).find((inner) => inner.field === 1);
          if (key) publicKeys.push(key.bytes);
        } else if (entry.field === 10000) {
          const id = fields(entry.bytes).find((inner) => inner.field === 1);
          if (id) crxId = id.bytes;
        }
      }
      return { ok: true, header: { zipOffset: 12 + size, crxId, publicKeys } };
    }
    if (version === 2) {
      const keyLength = u32(data, 8);
      const signatureLength = u32(data, 12);
      if (16 + keyLength + signatureLength > data.length)
        return { ok: false, error: 'The package is cut short.' };
      return {
        ok: true,
        header: {
          zipOffset: 16 + keyLength + signatureLength,
          crxId: null,
          publicKeys: [data.slice(16, 16 + keyLength)],
        },
      };
    }
    return { ok: false, error: `Package format ${String(version)} is not supported.` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The extension id in a Web Store address (`.../detail/<name>/<id>`) or a bare id. */
export function extensionIdFromInput(input: string): string | null {
  const text = input.trim();
  if (isExtensionId(text)) return text;
  const found = /(?:^|[/=])([a-p]{32})(?:[/?#&]|$)/.exec(text);
  return found?.[1] ?? null;
}
