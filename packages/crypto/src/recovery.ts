/**
 * Adapted from Happy — https://github.com/slopus/happy (MIT)
 * Original: happy/packages/happy-app/sources/auth/secretKeyBackup.ts
 *
 * Recovery code: masterSecret <-> user-readable grouped Base32, 1Password-style
 * ("XXXXX-XXXXX-XXXXX-...", 12 groups). Delta from Happy's original: operates
 * directly on the raw masterSecret bytes instead of a base64url string (this
 * package owns the bytes end-to-end, no serialization round-trip needed), and
 * `decodeRecoveryCode` returns `null` instead of throwing (design principle #1
 * — never throw on untrusted input, including a mistyped recovery code).
 *
 * CHECKSUM (docs/bug-fix-plan.md issue #12, known-issues.md "Recovery code can
 * silently create a disconnected account instead of failing"): the original
 * version of this format had no way to tell a garbled/made-up code from a real
 * one — anything that happened to decode to exactly 32 bytes was accepted, so
 * a wrong-but-well-formed code sailed straight through to the server, which
 * (being upsert-based) silently minted a fresh, disconnected account instead
 * of failing. The encoded payload is now `masterSecret (32B) || checksum (4B)`
 * — `checksum` is `sha512(masterSecret).slice(0, 4)` (SHA-512 via tweetnacl,
 * the same primitive `keys.ts`'s HMAC construction already uses, so no new
 * dependency) — giving a 1-in-2^32 chance a garbled code is accepted by
 * accident. `decodeRecoveryCode` recomputes it from the decoded secret and
 * returns `null` on any mismatch, client-side, before a network call is ever
 * made. This is a wire-format break from the unchecksummed version: since
 * Falcon is pre-launch (no real user has a real account depending on an
 * old-format code), there is no compatibility shim for the old 32-byte-only
 * format.
 *
 * Base32 alphabet (RFC 4648) minus the four characters normalization maps
 * away from (0, 1, 8, 9) — see `normalize` below.
 */
import tweetnacl from "tweetnacl";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const GROUP_SIZE = 5;
const MASTER_SECRET_LENGTH = 32;
const CHECKSUM_LENGTH = 4;
const PAYLOAD_LENGTH = MASTER_SECRET_LENGTH + CHECKSUM_LENGTH;

/** `sha512(masterSecret).slice(0, 4)` — see the module docblock's CHECKSUM note. */
function computeChecksum(masterSecret: Uint8Array): Uint8Array {
  return tweetnacl.hash(masterSecret).slice(0, CHECKSUM_LENGTH);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

function bytesToBase32(bytes: Uint8Array): string {
  let result = "";
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
    .replaceAll("0", "O")
    .replaceAll("1", "I")
    .replaceAll("8", "B")
    .replaceAll("9", "G");

  const cleaned = normalized.replace(/[^A-Z2-7]/g, "");
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
 * "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX"
 * (12 groups) — the masterSecret followed by its 4-byte checksum (see the
 * module docblock's CHECKSUM note), grouped after Base32 encoding.
 */
export function encodeRecoveryCode(masterSecret: Uint8Array): string {
  const checksum = computeChecksum(masterSecret);
  const payload = new Uint8Array(PAYLOAD_LENGTH);
  payload.set(masterSecret, 0);
  payload.set(checksum, MASTER_SECRET_LENGTH);

  const base32 = bytesToBase32(payload);
  const groups: string[] = [];
  for (let i = 0; i < base32.length; i += GROUP_SIZE) {
    groups.push(base32.slice(i, i + GROUP_SIZE));
  }
  return groups.join("-");
}

/**
 * Parse a user-entered recovery code back to the 32-byte masterSecret.
 * Tolerates dashes/spaces/lowercase and the 0/1/8/9 typo substitutions.
 * Returns `null` (never throws) if the code doesn't decode to exactly
 * `masterSecret (32B) || checksum (4B)`, or if the trailing checksum doesn't
 * match `sha512(masterSecret).slice(0, 4)` — including on garbage input or a
 * well-formed-looking but never-issued code (see the module docblock's
 * CHECKSUM note: this is what makes that case fail client-side, before any
 * network call).
 */
export function decodeRecoveryCode(code: string): Uint8Array | null {
  const bytes = base32ToBytes(code);
  if (!bytes || bytes.length !== PAYLOAD_LENGTH) {
    return null;
  }

  const masterSecret = bytes.slice(0, MASTER_SECRET_LENGTH);
  const checksum = bytes.slice(MASTER_SECRET_LENGTH);
  const expectedChecksum = computeChecksum(masterSecret);
  if (!constantTimeEqual(checksum, expectedChecksum)) {
    return null;
  }

  return masterSecret;
}
