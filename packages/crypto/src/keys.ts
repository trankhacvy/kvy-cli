/**
 * Key derivation from a client-held masterSecret (HMAC-SHA512, BIP32-style
 * master-seed expansion flattened to a single-level domain list):
 *
 * masterSecret (32B, generated client-side, never leaves clients unwrapped)
 *  ├─ HKDF("kvy-auth")        → ed25519 seed → signing keypair   (server auth challenge)
 *  ├─ HKDF("kvy-content")     → x25519 seed  → content keypair   (wraps DEKs)
 *  ├─ HKDF("kvy-anon")        → anonId (16 hex)                  (analytics identity)
 *  └─ HKDF("kvy-blob-master") → legacy/global blob key           (rarely used)
 *
 * Synchronous because tweetnacl.hash (SHA-512) is pure JS — no async WASM/native
 * boundary. Deliberately dependency-free of `./encryption(.web).ts` so it needs
 * no platform split.
 */
import tweetnacl from "tweetnacl";
import type { KeyTree } from "./types.js";

const HMAC_BLOCK_SIZE = 128; // SHA-512 block size in bytes

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Pure-JS HMAC-SHA512, built on tweetnacl's SHA-512 (`nacl.hash`). */
function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  const actualKey = key.length > HMAC_BLOCK_SIZE ? tweetnacl.hash(key) : key;
  const paddedKey = new Uint8Array(HMAC_BLOCK_SIZE);
  paddedKey.set(actualKey);

  const innerKey = new Uint8Array(HMAC_BLOCK_SIZE);
  const outerKey = new Uint8Array(HMAC_BLOCK_SIZE);
  for (let i = 0; i < HMAC_BLOCK_SIZE; i++) {
    // biome-ignore lint/style/noNonNullAssertion: loop bounds guarantee i < HMAC_BLOCK_SIZE <= paddedKey.length
    innerKey[i] = paddedKey[i]! ^ 0x36;
    // biome-ignore lint/style/noNonNullAssertion: same bound as above
    outerKey[i] = paddedKey[i]! ^ 0x5c;
  }

  const innerHash = tweetnacl.hash(concatBytes(innerKey, data));
  return tweetnacl.hash(concatBytes(outerKey, innerHash));
}

/**
 * Derive a 32-byte domain-separated seed from masterSecret.
 * `label` is the domain separator (e.g. "kvy-auth") — same masterSecret,
 * different label, produces cryptographically independent output.
 */
function deriveDomainSeed(masterSecret: Uint8Array, label: string): Uint8Array {
  const hmacKey = new TextEncoder().encode(`${label} Master Seed`);
  return hmacSha512(hmacKey, masterSecret).slice(0, 32);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 *
 *   • blob key: HKDF(DEK, "kvy-blobs")   → attachments isolated from text
 *
 * Unlike `deriveKeyTree`'s domains (all rooted in `masterSecret`), this one
 * is rooted in a *DEK* (a session's or machine's row-level data-encryption
 * key, already held by whichever client unwrapped it) — same
 * `deriveDomainSeed` construction, different input, so blob ciphertext for a
 * given session/machine is cryptographically independent of that session's
 * own message/metadata ciphertext even though both ultimately trace back to
 * the same DEK. Feed the result to `encryptBlob`/`decryptBlob`.
 */
export function deriveBlobKey(dek: Uint8Array): Uint8Array {
  return deriveDomainSeed(dek, "kvy-blobs");
}

/**
 * Derive the full Kvy key hierarchy from a client-held masterSecret.
 * Deterministic: the same masterSecret always yields the same tree.
 */
export function deriveKeyTree(masterSecret: Uint8Array): KeyTree {
  const authSeed = deriveDomainSeed(masterSecret, "kvy-auth");
  const contentSeed = deriveDomainSeed(masterSecret, "kvy-content");
  const anonSeed = deriveDomainSeed(masterSecret, "kvy-anon");
  const blobMasterKey = deriveDomainSeed(masterSecret, "kvy-blob-master");

  const signing = tweetnacl.sign.keyPair.fromSeed(authSeed);

  // Matches libsodium's crypto_box_seed_keypair (and this package's own
  // libsodiumPublicKeyFromSecretKey): sha512(seed).slice(0,32) is the X25519
  // secret scalar. Doing the hash here (once, at derivation time) instead of
  // calling into ./encryption.ts keeps this module free of the node/web split.
  const contentSecretKey = tweetnacl.hash(contentSeed).slice(0, 32);
  const content = tweetnacl.box.keyPair.fromSecretKey(contentSecretKey);

  return {
    signing: {
      publicKey: new Uint8Array(signing.publicKey),
      secretKey: new Uint8Array(signing.secretKey),
    },
    content: {
      publicKey: new Uint8Array(content.publicKey),
      secretKey: new Uint8Array(contentSecretKey),
    },
    anonId: toHex(anonSeed).slice(0, 16),
    blobMasterKey,
  };
}

/**
 * Sign `message` with an Ed25519 secret key from `KeyTree.signing` — the
 * primitive the sign-in flow needs to turn a locally-generated challenge into
 * challenge with ed25519"). Colocated with `deriveKeyTree` (rather than
 * `encryption(.web).ts`) because both operate on the same tweetnacl-native
 * keypair format — `keys.test.ts` already proves `tweetnacl.sign.detached`
 * round-trips correctly against it.
 */
export function signDetached(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return new Uint8Array(tweetnacl.sign.detached(message, secretKey));
}

/** Verify a `signDetached` signature against a `KeyTree.signing.publicKey`. Never throws. */
export function verifyDetached(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return tweetnacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}
