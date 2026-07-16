/**
 * EncryptedBox wrappers — browser build. Async because `encryptWithDataKey`/
 * `decryptWithDataKey` are async on this platform (Web Crypto API has no sync
 * variant — see encryption.web.ts). Same never-throws contract as box.ts:
 * `open()` resolves to `null` on any failure, it never rejects.
 *
 * Not itself a Happy port (see box.ts, which this mirrors). The primitives it
 * wraps are adapted from Happy — https://github.com/slopus/happy (MIT); see
 * `encryption.web.ts`'s header for the full license text those primitives carry.
 */
import {
  decodeBase64,
  decryptWithDataKey,
  encodeBase64,
  encryptWithDataKey,
} from "./encryption.web.js";
import type { EncryptedBox } from "./types.js";

/** Seal `data` into an EncryptedBox using AES-256-GCM under `dek`. */
export async function seal(data: unknown, dek: Uint8Array): Promise<EncryptedBox> {
  return { t: "enc", v: 1, c: encodeBase64(await encryptWithDataKey(data, dek)) };
}

/**
 * Open an EncryptedBox with `dek`. Resolves to `null` on any failure — never rejects.
 *
 * IMPORTANT: this deliberately does NOT validate `box.t`/`box.v` — it only ever
 * reads `box.c`. @falcon/crypto has no dependency on @falcon/wire (see types.ts),
 * so `EncryptedBox` here is structurally identical to `EncryptedBoxSchema` by
 * convention only, not by enforced coupling. Callers MUST validate `box.t === 'enc'`
 * and `box.v === 1` (e.g. via @falcon/wire's `EncryptedBoxSchema.parse`) BEFORE
 * calling `open()` — this function provides no defense against a well-formed-but-
 * wrong-shaped box as long as `box.c` happens to decrypt under `dek`.
 */
export async function open<T>(box: EncryptedBox, dek: Uint8Array): Promise<T | null> {
  return decryptWithDataKey(decodeBase64(box.c), dek);
}
