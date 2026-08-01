/**
 * Shared types for @kvy/crypto.
 *
 * Deliberately zod-free and dependency-free: @kvy/crypto has no dependency
 * on @kvy/wire so it can be built fully in parallel with it. The shape
 * here is structurally identical to `EncryptedBoxSchema` in @kvy/wire —
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
 * See kvy-system-design.md §5.1.
 */
export interface KeyTree {
  /** Ed25519 signing keypair — server auth challenge (HKDF("kvy-auth")). */
  signing: SignKeyPair;
  /** X25519 content keypair — wraps per-session/per-machine DEKs (HKDF("kvy-content")). */
  content: BoxKeyPair;
  /** Stable pseudonymous identifier, 16 hex chars (HKDF("kvy-anon")). */
  anonId: string;
  /** Legacy/global blob key, rarely used directly (HKDF("kvy-blob-master")). */
  blobMasterKey: Uint8Array;
}

/**
 * A `masterSecret` (or, for the daemon's reduced-custody mode, a content
 * bundle) PIN-wrapped at rest (issue-4-plan.md §6.1). All fields are base64.
 * `kdf` is carried explicitly so a future KDF change is a versioned,
 * detectable migration rather than a silent parameter drift.
 */
export interface PinWrapped {
  v: 1;
  kdf: "argon2id";
  /** argon2id salt, 16 bytes. */
  salt: string;
  /** AES-256-GCM nonce, 12 bytes. */
  nonce: string;
  /** AES-256-GCM ciphertext with the 16-byte auth tag appended. */
  ct: string;
}
