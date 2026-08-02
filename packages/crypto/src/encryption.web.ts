/**
 * Browser entry point (`@kvy/crypto/web`). Wire formats are byte-identical to
 * `encryption.ts` — a node-encrypted bundle decrypts fine here and vice versa.
 *
 * Two API differences forced by browser APIs:
 *  1. `encryptWithDataKey` / `decryptWithDataKey` are `async` — Web Crypto API
 *     (`crypto.subtle`) has no synchronous variant.
 *  2. Every other function requires libsodium's WASM module to be initialized
 *     first: `await ready()` once at startup, then all sync calls are safe.
 */
import sodium from "libsodium-wrappers";
import { decodeBase64, encodeBase64, encodeBase64Url } from "./base64.js";

export { decodeBase64, encodeBase64, encodeBase64Url };

/** Await once before calling any other export in this module. */
export const ready: Promise<void> = sodium.ready.then(() => undefined);

/**
 * Generate secure random bytes (libsodium's CSPRNG).
 */
export function getRandomBytes(size: number): Uint8Array {
  return sodium.randombytes_buf(size);
}

export function libsodiumPublicKeyFromSecretKey(seed: Uint8Array): Uint8Array {
  return new Uint8Array(sodium.crypto_box_seed_keypair(seed).publicKey);
}

/**
 * A throwaway X25519 keypair for one device-to-device handshake — the recipient half of
 * `libsodiumEncryptForPublicKey`. Callers hold the secret key only in memory, for the
 * lifetime of a single request, and never persist it.
 */
export function generateEphemeralKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const keyPair = sodium.crypto_box_keypair();
  return {
    publicKey: new Uint8Array(keyPair.publicKey),
    secretKey: new Uint8Array(keyPair.privateKey),
  };
}

export function libsodiumEncryptForPublicKey(
  data: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array {
  const ephemeralKeyPair = sodium.crypto_box_keypair();
  const nonce = getRandomBytes(sodium.crypto_box_NONCEBYTES);
  const encrypted = sodium.crypto_box_easy(
    data,
    nonce,
    recipientPublicKey,
    ephemeralKeyPair.privateKey,
  );

  // Bundle format: ephemeral public key (32 bytes) + nonce (24 bytes) + encrypted data
  const result = new Uint8Array(
    ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length,
  );
  result.set(ephemeralKeyPair.publicKey, 0);
  result.set(nonce, ephemeralKeyPair.publicKey.length);
  result.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);
  return result;
}

/** Inverse of libsodiumEncryptForPublicKey. Never throws — returns null on any failure. */
export function libsodiumDecryptWithSecretKey(
  bundle: Uint8Array,
  recipientSecretKey: Uint8Array,
): Uint8Array | null {
  const pubLen = sodium.crypto_box_PUBLICKEYBYTES;
  const nonceLen = sodium.crypto_box_NONCEBYTES;
  if (bundle.length < pubLen + nonceLen) {
    return null;
  }
  const ephemeralPublicKey = bundle.slice(0, pubLen);
  const nonce = bundle.slice(pubLen, pubLen + nonceLen);
  const ciphertext = bundle.slice(pubLen + nonceLen);
  try {
    return sodium.crypto_box_open_easy(ciphertext, nonce, ephemeralPublicKey, recipientSecretKey);
  } catch {
    return null;
  }
}

/**
 * Encrypt data using the secret key (NaCl secretbox — XSalsa20-Poly1305).
 */
export function encryptLegacy(data: any, secret: Uint8Array): Uint8Array {
  const nonce = getRandomBytes(sodium.crypto_secretbox_NONCEBYTES);
  const encrypted = sodium.crypto_secretbox_easy(
    new TextEncoder().encode(JSON.stringify(data)),
    nonce,
    secret,
  );
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce);
  result.set(encrypted, nonce.length);
  return result;
}

/** Never throws — returns null on any decryption failure. */
export function decryptLegacy(data: Uint8Array, secret: Uint8Array): any | null {
  if (data.length < sodium.crypto_secretbox_NONCEBYTES) {
    return null;
  }
  const nonce = data.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const encrypted = data.slice(sodium.crypto_secretbox_NONCEBYTES);
  try {
    const decrypted = sodium.crypto_secretbox_open_easy(encrypted, nonce, secret);
    if (!decrypted) {
      return null;
    }
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    return null;
  }
}

/**
 * Encrypt a binary blob with NaCl crypto_secretbox (XSalsa20-Poly1305).
 * Wire format: [nonce (24 bytes)] [ciphertext + auth tag (16 bytes + data)]
 */
export function encryptBlob(data: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = getRandomBytes(sodium.crypto_secretbox_NONCEBYTES);
  const encrypted = sodium.crypto_secretbox_easy(data, nonce, key);
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce, 0);
  result.set(encrypted, nonce.length);
  return result;
}

/** Never throws — returns null on any decryption failure. */
export function decryptBlob(bundle: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (bundle.length < sodium.crypto_secretbox_NONCEBYTES + 16) {
    return null;
  }
  const nonce = bundle.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = bundle.slice(sodium.crypto_secretbox_NONCEBYTES);
  try {
    return sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
  } catch {
    return null;
  }
}

async function importAesGcmKey(dataKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", dataKey as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt data using AES-256-GCM (WebCrypto). Async — WebCrypto has no sync
 * variant. Bundle layout is byte-identical to the node build's output.
 */
export async function encryptWithDataKey(data: any, dataKey: Uint8Array): Promise<Uint8Array> {
  const nonce = getRandomBytes(12); // GCM uses 12-byte nonces
  const key = await importAesGcmKey(dataKey);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  // WebCrypto's AES-GCM output is ciphertext||tag concatenated — same layout node produces.
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      key,
      plaintext as BufferSource,
    ),
  );

  const bundle = new Uint8Array(1 + nonce.length + encrypted.length);
  bundle[0] = 0;
  bundle.set(nonce, 1);
  bundle.set(encrypted, 1 + nonce.length);
  return bundle;
}

/**
 * Decrypt data using AES-256-GCM (WebCrypto). Async — WebCrypto has no sync
 * variant. Never rejects — resolves to null on any failure (one corrupt record
 * can't poison a sync batch).
 */
export async function decryptWithDataKey(
  bundle: Uint8Array,
  dataKey: Uint8Array,
): Promise<any | null> {
  if (bundle.length < 1) {
    return null;
  }
  if (bundle[0] !== 0) {
    return null;
  }
  if (bundle.length < 12 + 16 + 1) {
    return null;
  }
  const nonce = bundle.slice(1, 13);
  const ciphertextAndTag = bundle.slice(13); // WebCrypto expects ciphertext||tag concatenated

  try {
    const key = await importAesGcmKey(dataKey);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      key,
      ciphertextAndTag as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    return null;
  }
}

export function encrypt(
  key: Uint8Array,
  variant: "legacy" | "dataKey",
  data: any,
): Uint8Array | Promise<Uint8Array> {
  if (variant === "legacy") {
    return encryptLegacy(data, key);
  } else {
    return encryptWithDataKey(data, key);
  }
}

export function decrypt(
  key: Uint8Array,
  variant: "legacy" | "dataKey",
  data: Uint8Array,
): any | null | Promise<any | null> {
  if (variant === "legacy") {
    return decryptLegacy(data, key);
  } else {
    return decryptWithDataKey(data, key);
  }
}

/**
 * Generate authentication challenge response (Ed25519).
 */
export function authChallenge(secret: Uint8Array): {
  challenge: Uint8Array;
  publicKey: Uint8Array;
  signature: Uint8Array;
} {
  const keypair = sodium.crypto_sign_seed_keypair(secret);
  const challenge = getRandomBytes(32);
  const signature = sodium.crypto_sign_detached(challenge, keypair.privateKey);

  return {
    challenge,
    publicKey: new Uint8Array(keypair.publicKey),
    signature: new Uint8Array(signature),
  };
}
