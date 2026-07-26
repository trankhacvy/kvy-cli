/**
 * A per-browser AES-GCM wrapping key generated with `extractable: false`, used to wrap
 * secrets held in IndexedDB.
 *
 * ⚠️ HONEST SCOPE. Non-extractability prevents `crypto.subtle.exportKey`, NOT *use*.
 * IndexedDB is origin-scoped, so same-origin script — including XSS on the main thread —
 * can open the store, take the handle, and call `decrypt` with it. There is no
 * web-platform mechanism to bind a `CryptoKey` to a worker.
 *
 * What this actually buys, and all it buys: a raw file/backup copy of the IndexedDB store
 * yields ciphertext plus an unusable handle rather than a secret, and it is strictly
 * better than plaintext or `localStorage`. It is NOT an XSS defense. For a real at-rest
 * control, see `prf-key.ts` (a passkey-derived key that requires a user-verification
 * gesture and never exists at rest).
 */

const NONCE_BYTES = 12;

export interface WrappedBytes {
  nonce: Uint8Array;
  ct: Uint8Array;
}

export function createWrapKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function wrapBytes(key: CryptoKey, data: Uint8Array): Promise<WrappedBytes> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource },
    key,
    data as BufferSource,
  );
  return { nonce, ct: new Uint8Array(ct) };
}

/** Never throws — a corrupt blob or a foreign key resolves `null`, matching
 * `@falcon/crypto`'s own never-throw contract. */
export async function unwrapBytes(key: CryptoKey, blob: WrappedBytes): Promise<Uint8Array | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.nonce as BufferSource },
      key,
      blob.ct as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}
