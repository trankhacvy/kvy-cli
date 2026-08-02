/**
 * Node entry point for PIN-wrapping the client's `masterSecret` at rest
 * params, same 16-byte salt length as libsodium's `crypto_pwhash` — so a
 * wrapped blob is byte-portable between node (`@node-rs/argon2`) and the
 * browser build (`pin.web.ts`, libsodium-wrappers-sumo). See `pin.test.ts`
 * for the cross-platform parity vector.
 *
 * Deliberately async (unlike the plan's illustrative sync signature): argon2id
 * at these params is CPU-bound for ~100ms+, and both the node KDF
 * (`hashRaw`) and the browser's WASM `crypto_pwhash` call are naturally
 * exposed as promise-friendly here so a caller never blocks a UI thread /
 * the server's event loop.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { hashRaw } from "@node-rs/argon2";
import { decodeBase64, encodeBase64 } from "./base64.js";
import {
  ARGON2ID_MEMORY_COST_KIB,
  ARGON2ID_PARALLELISM,
  ARGON2ID_TIME_COST,
  PIN_KEY_BYTES,
  PIN_NONCE_BYTES,
  PIN_SALT_BYTES,
} from "./pin-params.js";
import type { PinWrapped } from "./types.js";

// `@node-rs/argon2`'s `Algorithm` is an ambient `const enum` — inaccessible
// under this project's `isolatedModules` (each file must transpile alone, and
// a const enum's members can't be inlined without cross-file type info). Its
// value (2) is documented in the package's own d.ts and stable across majors.
const ARGON2ID = 2;

async function deriveKey(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const raw = await hashRaw(pin, {
    salt: Buffer.from(salt),
    memoryCost: ARGON2ID_MEMORY_COST_KIB,
    timeCost: ARGON2ID_TIME_COST,
    parallelism: ARGON2ID_PARALLELISM,
    outputLen: PIN_KEY_BYTES,
    algorithm: ARGON2ID,
  });
  return new Uint8Array(raw);
}

/** Wrap `masterSecret` under a PIN-derived AES-256-GCM key. */
export async function wrapWithPin(masterSecret: Uint8Array, pin: string): Promise<PinWrapped> {
  const salt = new Uint8Array(randomBytes(PIN_SALT_BYTES));
  const nonce = new Uint8Array(randomBytes(PIN_NONCE_BYTES));
  const key = await deriveKey(pin, salt);

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(masterSecret), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    kdf: "argon2id",
    salt: encodeBase64(salt),
    nonce: encodeBase64(nonce),
    ct: encodeBase64(new Uint8Array(Buffer.concat([ciphertext, tag]))),
  };
}

/** Inverse of `wrapWithPin`. Never throws — returns `null` on a wrong PIN or corrupt blob. */
export async function unwrapWithPin(wrapped: PinWrapped, pin: string): Promise<Uint8Array | null> {
  if (wrapped.v !== 1 || wrapped.kdf !== "argon2id") return null;

  try {
    const salt = decodeBase64(wrapped.salt);
    const nonce = decodeBase64(wrapped.nonce);
    const ctAndTag = decodeBase64(wrapped.ct);
    if (ctAndTag.length < 16) return null;

    const tag = ctAndTag.slice(ctAndTag.length - 16);
    const ciphertext = ctAndTag.slice(0, ctAndTag.length - 16);
    const key = await deriveKey(pin, salt);

    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(Buffer.from(tag));
    return new Uint8Array(
      Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]),
    );
  } catch {
    // Wrong PIN (auth tag mismatch) or a corrupt/malformed blob — both collapse
    // to null per the package's never-throw contract (design principle #1).
    return null;
  }
}
