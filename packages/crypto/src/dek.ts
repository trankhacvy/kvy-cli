/**
 * Sealed-box DEK wrap/unwrap — falcon-system-design.md §5.1:
 *
 *   wrapped DEK = sealed-box(contentPubKey, DEK) = [ephPub32 | nonce24 | ct]
 *   stored server-side as opaque `dek` column: [0x00 | sealedBox]
 *
 * New code. `unwrapDek` never throws — returns `null` on any failure (wrong
 * key, corrupt bytes, unknown version byte), same contract as `box.open()`.
 *
 * Not itself a Happy port — this wrap/unwrap scheme is Falcon's DEK-column
 * design (falcon-system-design.md §5.1), built on `libsodiumEncryptForPublicKey`/
 * `libsodiumDecryptWithSecretKey`, which are adapted from Happy —
 * https://github.com/slopus/happy (MIT); see `encryption.ts`'s header for the
 * full license text those primitives carry.
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
