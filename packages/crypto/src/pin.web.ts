/**
 * for the shared param rationale and the node counterpart. Uses
 * `libsodium-wrappers-sumo` (not the slim `libsodium-wrappers` the rest of
 * this package's browser build uses) because `crypto_pwhash` — the argon2id
 * KDF — is only compiled into the "sumo" WASM build; the slim build omits it
 * to save bytes. AES-GCM reuses the same WebCrypto path as `encryption.web.ts`.
 */
import sodium from "libsodium-wrappers-sumo";
import { decodeBase64, encodeBase64 } from "./base64.js";
import {
  ARGON2ID_MEMORY_COST_KIB,
  ARGON2ID_TIME_COST,
  PIN_KEY_BYTES,
  PIN_NONCE_BYTES,
  PIN_SALT_BYTES,
} from "./pin-params.js";
import type { PinWrapped } from "./types.js";

/** Await once before calling `wrapWithPin`/`unwrapWithPin` (libsodium's WASM module needs to initialize). */
export const pinReady: Promise<void> = sodium.ready.then(() => undefined);

// libsodium's crypto_pwhash has no `timeCost`/`memoryCost` knobs directly — it
// takes opslimit (iteration count, same idea as timeCost) and memlimit in
// BYTES (node's memoryCost is KiB) plus a fixed algorithm id. Matching
// `pin-params.ts` exactly here is what makes a blob cross-platform-portable.
const OPSLIMIT = ARGON2ID_TIME_COST;
const MEMLIMIT_BYTES = ARGON2ID_MEMORY_COST_KIB * 1024;

function deriveKey(pin: string, salt: Uint8Array): Uint8Array {
  return sodium.crypto_pwhash(
    PIN_KEY_BYTES,
    pin,
    salt,
    OPSLIMIT,
    MEMLIMIT_BYTES,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

async function importAesGcmKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Wrap `masterSecret` under a PIN-derived AES-256-GCM key. */
export async function wrapWithPin(masterSecret: Uint8Array, pin: string): Promise<PinWrapped> {
  const salt = sodium.randombytes_buf(PIN_SALT_BYTES);
  const nonce = sodium.randombytes_buf(PIN_NONCE_BYTES);
  const key = deriveKey(pin, salt);

  const cryptoKey = await importAesGcmKey(key);
  const ctAndTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      cryptoKey,
      masterSecret as BufferSource,
    ),
  );

  return {
    v: 1,
    kdf: "argon2id",
    salt: encodeBase64(salt),
    nonce: encodeBase64(nonce),
    ct: encodeBase64(ctAndTag),
  };
}

/** Inverse of `wrapWithPin`. Never rejects — resolves to `null` on a wrong PIN or corrupt blob. */
export async function unwrapWithPin(wrapped: PinWrapped, pin: string): Promise<Uint8Array | null> {
  if (wrapped.v !== 1 || wrapped.kdf !== "argon2id") return null;

  try {
    const salt = decodeBase64(wrapped.salt);
    const nonce = decodeBase64(wrapped.nonce);
    const ctAndTag = decodeBase64(wrapped.ct);
    const key = deriveKey(pin, salt);
    const cryptoKey = await importAesGcmKey(key);

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      cryptoKey,
      ctAndTag as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    // Wrong PIN (auth tag mismatch) or a corrupt/malformed blob.
    return null;
  }
}
