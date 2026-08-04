/**
 * Isomorphic base64 / base64url codec — no Buffer, no atob/btoa, no Node built-ins.
 * Shared by both the node and browser entry points so encoding is guaranteed
 * byte-identical across platforms.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  table["=".charCodeAt(0)] = -2; // padding sentinel
  return table;
})();

export function encodeBase64(
  buffer: Uint8Array,
  variant: "base64" | "base64url" = "base64",
): string {
  let result = "";
  for (let i = 0; i < buffer.length; i += 3) {
    // biome-ignore lint/style/noNonNullAssertion: loop bounds guarantee these indices are in range
    const b0 = buffer[i]!;
    // biome-ignore lint/style/noNonNullAssertion: guarded by the i+1 < length check
    const b1 = i + 1 < buffer.length ? buffer[i + 1]! : undefined;
    // biome-ignore lint/style/noNonNullAssertion: guarded by the i+2 < length check
    const b2 = i + 2 < buffer.length ? buffer[i + 2]! : undefined;

    result += ALPHABET[b0 >> 2];
    result += ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    result +=
      b1 === undefined ? "=" : ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    result += b2 === undefined ? "=" : ALPHABET[b2 & 0x3f];
  }
  if (variant === "base64url") {
    return result.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }
  return result;
}

/** Encode a Uint8Array to base64url string (URL-safe base64, no padding). */
export function encodeBase64Url(buffer: Uint8Array): string {
  return encodeBase64(buffer, "base64url");
}

/**
 * Decode a base64 (or base64url) string to a Uint8Array.
 *
 * WARNING: never throws — any character outside the selected variant's alphabet
 * is silently dropped rather than rejected. Passing the wrong `variant` for the
 * input string will NOT raise an error; it will silently produce the wrong bytes.
 * Always pass the `variant` that matches how the string was encoded.
 */
export function decodeBase64(
  base64: string,
  variant: "base64" | "base64url" = "base64",
): Uint8Array {
  const input = variant === "base64url" ? base64.replaceAll("-", "+").replaceAll("_", "/") : base64;

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
