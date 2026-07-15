/**
 * EncryptedBox wrappers around encryptWithDataKey/decryptWithDataKey — the
 * shape every ciphertext payload travels the wire in. New code (design
 * principle #1): `open()` returns `null` on any failure, it never throws —
 * one corrupt record can't poison a sync batch.
 */
import { decodeBase64, encodeBase64, encryptWithDataKey, decryptWithDataKey } from './encryption.js';
import type { EncryptedBox } from './types.js';

/** Seal `data` into an EncryptedBox using AES-256-GCM under `dek`. */
export function seal(data: unknown, dek: Uint8Array): EncryptedBox {
  return { t: 'enc', v: 1, c: encodeBase64(encryptWithDataKey(data, dek)) };
}

/**
 * Open an EncryptedBox with `dek`. Returns `null` on any failure — never throws.
 *
 * IMPORTANT: this deliberately does NOT validate `box.t`/`box.v` — it only ever
 * reads `box.c`. @falcon/crypto has no dependency on @falcon/wire (see types.ts),
 * so `EncryptedBox` here is structurally identical to `EncryptedBoxSchema` by
 * convention only, not by enforced coupling. Callers MUST validate `box.t === 'enc'`
 * and `box.v === 1` (e.g. via @falcon/wire's `EncryptedBoxSchema.parse`) BEFORE
 * calling `open()` — this function provides no defense against a well-formed-but-
 * wrong-shaped box as long as `box.c` happens to decrypt under `dek`.
 */
export function open<T>(box: EncryptedBox, dek: Uint8Array): T | null {
  return decryptWithDataKey(decodeBase64(box.c), dek);
}
