import {
  decodeBase64,
  decryptWithDataKey,
  encodeBase64,
  encryptWithDataKey,
} from "./encryption.js";
import type { EncryptedBox } from "./types.js";

/** Seal `data` into an EncryptedBox using AES-256-GCM under `dek`. */
export function seal(data: unknown, dek: Uint8Array): EncryptedBox {
  return { t: "enc", v: 1, c: encodeBase64(encryptWithDataKey(data, dek)) };
}

/**
 * Open an EncryptedBox with `dek`. Returns `null` on any failure — never throws.
 *
 * IMPORTANT: does NOT validate `box.t`/`box.v` — only reads `box.c`.
 * Callers MUST validate `box.t === 'enc'` and `box.v === 1`
 * (e.g. via @kvy/wire's `EncryptedBoxSchema.parse`) BEFORE calling `open()` —
 * this function provides no defense against a wrong-shaped box as long as
 * `box.c` happens to decrypt under `dek`.
 */
export function open<T>(box: EncryptedBox, dek: Uint8Array): T | null {
  return decryptWithDataKey(decodeBase64(box.c), dek);
}
