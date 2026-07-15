/**
 * Isomorphic base64 / base64url codec — no Buffer, no atob/btoa, no Node built-ins.
 * Shared verbatim by both the node (`index.ts`) and browser (`index.web.ts`) entry
 * points so encoding is guaranteed byte-identical across platforms (load-bearing
 * for the cross-impl test vectors in `cross-impl.test.ts`).
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  table['='.charCodeAt(0)] = -2; // padding sentinel
  return table;
})();

/**
 * Encode a Uint8Array to base64 string.
 * @param buffer - The buffer to encode
 * @param variant - The encoding variant ('base64' or 'base64url')
 */
export function encodeBase64(buffer: Uint8Array, variant: 'base64' | 'base64url' = 'base64'): string {
  let result = '';
  for (let i = 0; i < buffer.length; i += 3) {
    const b0 = buffer[i]!;
    const b1 = i + 1 < buffer.length ? buffer[i + 1]! : undefined;
    const b2 = i + 2 < buffer.length ? buffer[i + 2]! : undefined;

    result += ALPHABET[b0 >> 2];
    result += ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    result += b1 === undefined ? '=' : ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    result += b2 === undefined ? '=' : ALPHABET[b2 & 0x3f];
  }
  if (variant === 'base64url') {
    return result.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }
  return result;
}

/** Encode a Uint8Array to base64url string (URL-safe base64, no padding). */
export function encodeBase64Url(buffer: Uint8Array): string {
  return encodeBase64(buffer, 'base64url');
}

/**
 * Decode a base64 (or base64url) string to a Uint8Array.
 *
 * WARNING: this never throws (package-wide "never throw" philosophy) — any
 * character outside the selected variant's alphabet (e.g. '-'/'_' when
 * decoding with the default 'base64' variant, or '+'/'/' when decoding with
 * 'base64url') is silently dropped rather than rejected. Passing the wrong
 * `variant` for the input string will NOT raise an error; it will silently
 * produce the wrong bytes. Always pass the `variant` that matches how the
 * string was encoded (see `encodeBase64`).
 *
 * @param base64 - The base64 string to decode
 * @param variant - The encoding variant ('base64' or 'base64url') — must match the encoder's variant
 */
export function decodeBase64(base64: string, variant: 'base64' | 'base64url' = 'base64'): Uint8Array {
  const input = variant === 'base64url' ? base64.replaceAll('-', '+').replaceAll('_', '/') : base64;

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const value = code < 128 ? (LOOKUP[code] ?? -1) : -1;
    if (value === -2 || value === -1) continue; // padding / whitespace / out-of-range, just skip
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}
