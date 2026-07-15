/**
 * EncryptedBox wrappers — browser build. Async because `encryptWithDataKey`/
 * `decryptWithDataKey` are async on this platform (Web Crypto API has no sync
 * variant — see encryption.web.ts). Same never-throws contract as box.ts:
 * `open()` resolves to `null` on any failure, it never rejects.
 */
import { decodeBase64, encodeBase64, encryptWithDataKey, decryptWithDataKey } from './encryption.web.js';
import type { EncryptedBox } from './types.js';

/** Seal `data` into an EncryptedBox using AES-256-GCM under `dek`. */
export async function seal(data: unknown, dek: Uint8Array): Promise<EncryptedBox> {
  return { t: 'enc', v: 1, c: encodeBase64(await encryptWithDataKey(data, dek)) };
}

/** Open an EncryptedBox with `dek`. Resolves to `null` on any failure — never rejects. */
export async function open<T>(box: EncryptedBox, dek: Uint8Array): Promise<T | null> {
  return decryptWithDataKey(decodeBase64(box.c), dek);
}
