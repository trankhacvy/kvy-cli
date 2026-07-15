/**
 * Ported (near-verbatim) from Happy — https://github.com/slopus/happy
 * Original: happy/packages/happy-cli/src/api/encryption.ts
 *
 * MIT License
 * Copyright (c) 2026 Happy Coder Contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ---
 * Node entry point (default `import`/`require` condition of @falcon/crypto).
 * Uses node:crypto for AES-256-GCM + random bytes, tweetnacl for NaCl box/
 * secretbox/sign. See `encryption.web.ts` for the browser counterpart
 * (libsodium-wrappers + WebCrypto AES-GCM).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64, encodeBase64Url } from './base64.js';

export { decodeBase64, encodeBase64, encodeBase64Url };

/**
 * Generate secure random bytes
 */
export function getRandomBytes(size: number): Uint8Array {
  return new Uint8Array(randomBytes(size));
}

export function libsodiumPublicKeyFromSecretKey(seed: Uint8Array): Uint8Array {
  // NOTE: This matches libsodium implementation, tweetnacl doesnt do this by default
  const hashedSeed = new Uint8Array(createHash('sha512').update(seed).digest());
  const secretKey = hashedSeed.slice(0, 32);
  return new Uint8Array(tweetnacl.box.keyPair.fromSecretKey(secretKey).publicKey);
}

export function libsodiumEncryptForPublicKey(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  // Generate ephemeral keypair for this encryption
  const ephemeralKeyPair = tweetnacl.box.keyPair();

  // Generate random nonce (24 bytes for box encryption)
  const nonce = getRandomBytes(tweetnacl.box.nonceLength);

  // Encrypt the data using box (authenticated encryption)
  const encrypted = tweetnacl.box(data, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);

  // Bundle format: ephemeral public key (32 bytes) + nonce (24 bytes) + encrypted data
  const result = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length);
  result.set(ephemeralKeyPair.publicKey, 0);
  result.set(nonce, ephemeralKeyPair.publicKey.length);
  result.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);

  return result;
}

/**
 * Inverse of libsodiumEncryptForPublicKey — open a [ephPub32|nonce24|ct] sealed
 * box with the recipient's secret key. Not present in Happy's original file
 * (Happy only ever encrypts *to* the app, never needs to open one CLI-side);
 * added here because @falcon/crypto's `unwrapDek` needs the symmetric decrypt.
 * Never throws — returns null on any failure (design principle #1).
 */
export function libsodiumDecryptWithSecretKey(bundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
  const pubLen = tweetnacl.box.publicKeyLength;
  const nonceLen = tweetnacl.box.nonceLength;
  if (bundle.length < pubLen + nonceLen) {
    return null;
  }
  const ephemeralPublicKey = bundle.slice(0, pubLen);
  const nonce = bundle.slice(pubLen, pubLen + nonceLen);
  const ciphertext = bundle.slice(pubLen + nonceLen);
  try {
    const decrypted = tweetnacl.box.open(ciphertext, nonce, ephemeralPublicKey, recipientSecretKey);
    if (!decrypted) {
      return null;
    }
    return new Uint8Array(decrypted);
  } catch {
    // tweetnacl throws on malformed inputs (e.g. wrong-length recipientSecretKey)
    // instead of returning null — normalize to this module's never-throw contract.
    return null;
  }
}

/**
 * Encrypt data using the secret key
 * @param data - The data to encrypt
 * @param secret - The secret key to use for encryption
 * @returns The encrypted data
 */
export function encryptLegacy(data: any, secret: Uint8Array): Uint8Array {
  const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
  const encrypted = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce);
  result.set(encrypted, nonce.length);
  return result;
}

/**
 * Decrypt data using the secret key
 * @param data - The data to decrypt
 * @param secret - The secret key to use for decryption
 * @returns The decrypted data
 */
export function decryptLegacy(data: Uint8Array, secret: Uint8Array): any | null {
  if (data.length < tweetnacl.secretbox.nonceLength) {
    return null;
  }
  const nonce = data.slice(0, tweetnacl.secretbox.nonceLength);
  const encrypted = data.slice(tweetnacl.secretbox.nonceLength);
  try {
    const decrypted = tweetnacl.secretbox.open(encrypted, nonce, secret);
    if (!decrypted) {
      // Decryption failed - returning null is sufficient for error handling
      // Callers should handle the null case appropriately
      return null;
    }
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    // tweetnacl throws on malformed inputs (e.g. wrong-length secret) and
    // JSON.parse throws on non-JSON plaintext — normalize both to null.
    return null;
  }
}

/**
 * Encrypt a binary blob with NaCl crypto_secretbox (XSalsa20-Poly1305).
 * Wire format: [nonce (24 bytes)] [ciphertext + auth tag (16 bytes + data)]
 * Matches the app-side encryptBlob() in packages/happy-app/sources/encryption/blob.ts.
 */
export function encryptBlob(data: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
  const dataStandalone = data.byteOffset === 0 && data.buffer.byteLength === data.length ? data : data.slice();
  const keyStandalone = key.byteOffset === 0 && key.buffer.byteLength === key.length ? key : key.slice();
  const encrypted = tweetnacl.secretbox(dataStandalone, nonce, keyStandalone);
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce, 0);
  result.set(encrypted, nonce.length);
  return result;
}

/**
 * Decrypt a binary blob encrypted with NaCl crypto_secretbox (XSalsa20-Poly1305).
 * Wire format: [nonce (24 bytes)] [ciphertext + auth tag (16 bytes + data)]
 * Matches the app-side encryptBlob() in packages/happy-app/sources/encryption/blob.ts.
 */
export function decryptBlob(bundle: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (bundle.length < tweetnacl.secretbox.nonceLength + 16) {
    return null;
  }
  const nonce = bundle.slice(0, tweetnacl.secretbox.nonceLength);
  const ciphertext = bundle.slice(tweetnacl.secretbox.nonceLength);
  try {
    const decrypted = tweetnacl.secretbox.open(ciphertext, nonce, key);
    if (!decrypted) {
      return null;
    }
    return new Uint8Array(decrypted);
  } catch {
    // tweetnacl throws on malformed inputs (e.g. wrong-length key) instead of
    // returning null — normalize to this module's never-throw contract.
    return null;
  }
}

/**
 * Encrypt data using AES-256-GCM with the data encryption key
 * @param data - The data to encrypt
 * @param dataKey - The 32-byte AES-256 key
 * @returns The encrypted data bundle (version + nonce + ciphertext + auth tag)
 */
export function encryptWithDataKey(data: any, dataKey: Uint8Array): Uint8Array {
  const nonce = getRandomBytes(12); // GCM uses 12-byte nonces
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);

  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const authTag = cipher.getAuthTag();

  // Bundle: version(1) + nonce (12) + ciphertext + auth tag (16)
  const bundle = new Uint8Array(12 + encrypted.length + 16 + 1);
  bundle.set([0], 0);
  bundle.set(nonce, 1);
  bundle.set(new Uint8Array(encrypted), 13);
  bundle.set(new Uint8Array(authTag), 13 + encrypted.length);

  return bundle;
}

/**
 * Decrypt data using AES-256-GCM with the data encryption key
 * @param bundle - The encrypted data bundle
 * @param dataKey - The 32-byte AES-256 key
 * @returns The decrypted data or null if decryption fails
 */
export function decryptWithDataKey(bundle: Uint8Array, dataKey: Uint8Array): any | null {
  if (bundle.length < 1) {
    return null;
  }
  if (bundle[0] !== 0) {
    // Only version 0
    return null;
  }
  if (bundle.length < 12 + 16 + 1) {
    // Minimum: version + nonce + auth tag
    return null;
  }

  const nonce = bundle.slice(1, 13);
  const authTag = bundle.slice(bundle.length - 16);
  const ciphertext = bundle.slice(13, bundle.length - 16);

  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (error) {
    // Decryption failed
    return null;
  }
}

export function encrypt(key: Uint8Array, variant: 'legacy' | 'dataKey', data: any): Uint8Array {
  if (variant === 'legacy') {
    return encryptLegacy(data, key);
  } else {
    return encryptWithDataKey(data, key);
  }
}

export function decrypt(key: Uint8Array, variant: 'legacy' | 'dataKey', data: Uint8Array): any | null {
  if (variant === 'legacy') {
    return decryptLegacy(data, key);
  } else {
    return decryptWithDataKey(data, key);
  }
}

/**
 * Generate authentication challenge response
 */
export function authChallenge(secret: Uint8Array): {
  challenge: Uint8Array;
  publicKey: Uint8Array;
  signature: Uint8Array;
} {
  const keypair = tweetnacl.sign.keyPair.fromSeed(secret);
  const challenge = getRandomBytes(32);
  const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);

  return {
    challenge,
    publicKey: keypair.publicKey,
    signature,
  };
}
