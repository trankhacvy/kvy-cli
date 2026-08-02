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

/** The key hierarchy derived from a client-held masterSecret. */
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
 * A `masterSecret` PIN-wrapped at rest. All fields are base64.
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
