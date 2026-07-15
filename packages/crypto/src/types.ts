/**
 * Shared types for @falcon/crypto.
 *
 * Deliberately zod-free and dependency-free: @falcon/crypto has no dependency
 * on @falcon/wire so it can be built fully in parallel with it. The shape
 * here is structurally identical to `EncryptedBoxSchema` in @falcon/wire —
 * that's a convention, not a coupling.
 */

/** The versioned, opaque envelope every encrypted payload travels in over the wire / in Postgres. */
export interface EncryptedBox {
  t: "enc";
  v: 1;
  /** base64-encoded ciphertext bundle produced by encryptWithDataKey. */
  c: string;
}

/** An X25519 keypair (NaCl `box`). */
export interface BoxKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** An Ed25519 keypair (NaCl `sign`). */
export interface SignKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * The key hierarchy derived from a client-held masterSecret.
 * See falcon-system-design.md §5.1.
 */
export interface KeyTree {
  /** Ed25519 signing keypair — server auth challenge (HKDF("falcon-auth")). */
  signing: SignKeyPair;
  /** X25519 content keypair — wraps per-session/per-machine DEKs (HKDF("falcon-content")). */
  content: BoxKeyPair;
  /** Stable pseudonymous identifier, 16 hex chars (HKDF("falcon-anon")). */
  anonId: string;
  /** Legacy/global blob key, rarely used directly (HKDF("falcon-blob-master")). */
  blobMasterKey: Uint8Array;
}
