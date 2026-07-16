/**
 * Sealed-box DEK wrap/unwrap — browser build. Sync (unlike box.web.ts): the
 * underlying NaCl box operations come from libsodium-wrappers, which is
 * synchronous once `ready` has resolved — only the AES-GCM data-key path
 * needs WebCrypto's async API. See dek.ts for the wire format.
 *
 * Not itself a Happy port (see dek.ts, which this mirrors). The primitives it
 * wraps are adapted from Happy — https://github.com/slopus/happy (MIT); see
 * `encryption.web.ts`'s header for the full license text those primitives carry.
 */
import { libsodiumDecryptWithSecretKey, libsodiumEncryptForPublicKey } from "./encryption.web.js";

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
