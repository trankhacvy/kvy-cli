/**
 * Key hierarchy — falcon-system-design.md §5.1.
 *
 * masterSecret (32B, generated client-side, never leaves clients unwrapped)
 *  ├─ HKDF("falcon-auth")        → ed25519 seed → signing keypair   (server auth challenge)
 *  ├─ HKDF("falcon-content")     → x25519 seed  → content keypair   (wraps DEKs)
 *  ├─ HKDF("falcon-anon")        → anonId (16 hex)                  (analytics identity)
 *  └─ HKDF("falcon-blob-master") → legacy/global blob key           (rarely used)
 *
 * New code (not present in Happy), but the derivation primitive is adapted
 * verbatim from Happy — https://github.com/slopus/happy (MIT) —
 * `happy-app/sources/encryption/deriveKey.ts` (HMAC-SHA512 master-seed
 * expansion, the same construction BIP32 uses for its root key) — flattened
 * to Falcon's single-level domain list instead of a full child-key path
 * tree, and made synchronous (Node's `tweetnacl.hash`
 * SHA-512 is pure JS, so there's no async WASM/native boundary to cross).
 * Deliberately isomorphic and dependency-free of `./encryption(.web).ts` so
 * it needs no platform split — one file, one implementation, both targets.
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
    innerKey[i] = paddedKey[i]! ^ 0x36;
    outerKey[i] = paddedKey[i]! ^ 0x5c;
  }

  const innerHash = tweetnacl.hash(concatBytes(innerKey, data));
  return tweetnacl.hash(concatBytes(outerKey, innerHash));
}

/**
 * Derive a 32-byte domain-separated seed from masterSecret.
 * `label` is the domain separator (e.g. "falcon-auth") — same masterSecret,
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
 * Derive the full Falcon key hierarchy from a client-held masterSecret.
 * Deterministic: the same masterSecret always yields the same tree.
 */
export function deriveKeyTree(masterSecret: Uint8Array): KeyTree {
  const authSeed = deriveDomainSeed(masterSecret, "falcon-auth");
  const contentSeed = deriveDomainSeed(masterSecret, "falcon-content");
  const anonSeed = deriveDomainSeed(masterSecret, "falcon-anon");
  const blobMasterKey = deriveDomainSeed(masterSecret, "falcon-blob-master");

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
 * the `signature` field of `POST /v1/auth` (design §5.2 "Sign-in": "sign 32B
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
