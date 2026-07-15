/**
 * Adapted from Happy — https://github.com/slopus/happy (MIT)
 * Original: happy/packages/happy-app/sources/auth/secretKeyBackup.ts
 *
 * Recovery code: masterSecret <-> user-readable grouped Base32, 1Password-style
 * ("XXXXX-XXXXX-XXXXX-...", 11 groups). Delta from Happy's original: operates
 * directly on the raw masterSecret bytes instead of a base64url string (this
 * package owns the bytes end-to-end, no serialization round-trip needed), and
 * `decodeRecoveryCode` returns `null` instead of throwing (design principle #1
 * — never throw on untrusted input, including a mistyped recovery code).
 *
 * Base32 alphabet (RFC 4648) minus the four characters normalization maps
 * away from (0, 1, 8, 9) — see `normalize` below.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const GROUP_SIZE = 5;
const MASTER_SECRET_LENGTH = 32;

function bytesToBase32(bytes: Uint8Array): string {
  let result = '';
  let buffer = 0;
  let bufferLength = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bufferLength += 8;

    while (bufferLength >= 5) {
      bufferLength -= 5;
      result += BASE32_ALPHABET[(buffer >> bufferLength) & 0x1f];
    }
  }

  if (bufferLength > 0) {
    result += BASE32_ALPHABET[(buffer << (5 - bufferLength)) & 0x1f];
  }

  return result;
}

/** Returns null (never throws) if the cleaned input contains no valid base32 characters. */
function base32ToBytes(base32: string): Uint8Array | null {
  // Error-tolerant normalization for characters people commonly mistype:
  // 0 (zero) -> O, 1 (one) -> I, 8 -> B, 9 -> G (arbitrary but consistent).
  const normalized = base32
    .toUpperCase()
    .replaceAll('0', 'O')
    .replaceAll('1', 'I')
    .replaceAll('8', 'B')
    .replaceAll('9', 'G');

  const cleaned = normalized.replace(/[^A-Z2-7]/g, '');
  if (cleaned.length === 0) {
    return null;
  }

  const bytes: number[] = [];
  let buffer = 0;
  let bufferLength = 0;

  for (const char of cleaned) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) {
      return null;
    }
    buffer = (buffer << 5) | value;
    bufferLength += 5;

    if (bufferLength >= 8) {
      bufferLength -= 8;
      bytes.push((buffer >> bufferLength) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

/**
 * Format a 32-byte masterSecret as a user-readable recovery code:
 * "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX" (11 groups).
 */
export function encodeRecoveryCode(masterSecret: Uint8Array): string {
  const base32 = bytesToBase32(masterSecret);
  const groups: string[] = [];
  for (let i = 0; i < base32.length; i += GROUP_SIZE) {
    groups.push(base32.slice(i, i + GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * Parse a user-entered recovery code back to the 32-byte masterSecret.
 * Tolerates dashes/spaces/lowercase and the 0/1/8/9 typo substitutions.
 * Returns `null` (never throws) if the code doesn't decode to exactly
 * 32 bytes — including on garbage input.
 */
export function decodeRecoveryCode(code: string): Uint8Array | null {
  const bytes = base32ToBytes(code);
  if (!bytes || bytes.length !== MASTER_SECRET_LENGTH) {
    return null;
  }
  return bytes;
}
