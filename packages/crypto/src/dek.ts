/**
 * Sealed-box DEK wrap/unwrap.
 *
 * Wire format: wrapped DEK = [0x00 | ephPub32 | nonce24 | ct]
 *
 * `unwrapDek` never throws — returns `null` on any failure (wrong key,
 * corrupt bytes, unknown version byte).
 */
import { libsodiumDecryptWithSecretKey, libsodiumEncryptForPublicKey } from "./encryption.js";

const WRAP_VERSION = 0x00;

/** Wrap a DEK to `contentPublicKey` — only the matching content secret key can unwrap it. */
export function wrapDek(dek: Uint8Array, contentPublicKey: Uint8Array): Uint8Array {
  const sealedBox = libsodiumEncryptForPublicKey(dek, contentPublicKey);
  const wrapped = new Uint8Array(1 + sealedBox.length);
  wrapped[0] = WRAP_VERSION;
  wrapped.set(sealedBox, 1);
  return wrapped;
}

/** Unwrap a DEK with the content secret key. Returns `null` on any failure — never throws. */
export function unwrapDek(wrapped: Uint8Array, contentSecretKey: Uint8Array): Uint8Array | null {
  if (wrapped.length < 1 || wrapped[0] !== WRAP_VERSION) {
    return null;
  }
  return libsodiumDecryptWithSecretKey(wrapped.slice(1), contentSecretKey);
}
