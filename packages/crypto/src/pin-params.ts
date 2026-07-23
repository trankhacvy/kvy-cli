/**
 * Shared argon2id KDF params for PIN-wrapping (§6.1). Both `pin.ts` (node,
 * `@node-rs/argon2`) and `pin.web.ts` (browser, libsodium-wrappers-sumo)
 * import from here so the two platforms can never drift apart — a mismatch
 * in any of these numbers breaks the cross-platform parity vector in
 * `pin.test.ts` and makes a wrapped blob non-portable.
 *
 * Salt length matches libsodium's fixed `crypto_pwhash_SALTBYTES` (16) so the
 * same salt works unmodified as the node KDF's explicit `salt` option.
 * Parallelism is 1 because libsodium's `crypto_pwhash` has no lanes/threads
 * parameter (always single-lane) — the node side must match to derive the
 * same bytes.
 */
export const PIN_SALT_BYTES = 16;
export const PIN_NONCE_BYTES = 12; // AES-GCM
export const PIN_KEY_BYTES = 32; // AES-256

export const ARGON2ID_MEMORY_COST_KIB = 65536; // 64 MiB
export const ARGON2ID_TIME_COST = 3;
export const ARGON2ID_PARALLELISM = 1;
