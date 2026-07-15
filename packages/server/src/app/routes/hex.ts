/**
 * Hex-encode raw key bytes to match the `accounts.signPublicKey` column
 * convention (design §6.1) — shared by every route that upserts an account
 * row keyed by its Ed25519 identity key (`auth.ts`, `oauth.ts`).
 */
export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
