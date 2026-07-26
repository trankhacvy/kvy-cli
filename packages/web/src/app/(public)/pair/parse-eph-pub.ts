import { decodeBase64, encodeBase64 } from "@falcon/crypto/web";

const X25519_PUBLIC_KEY_BYTES = 32;

/**
 * The CLI writes the pairing fragment as base64url (`encodeBase64Url`), but the server
 * keys the row by PLAIN base64 — `api/pair.ts` compares strings, not bytes. Convert once,
 * here, so no caller can forget: decoding a `+`/`/`-containing plain-base64 string as
 * base64url silently drops those characters and the key comes out short.
 *
 * Returns null for anything that isn't a 32-byte key.
 *
 * In its own module because a Next.js `page.tsx` may only export the default component
 * plus known metadata fields — same reason `pair-gate.ts` exists.
 */
export function parseEphPubFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const bytes = decodeBase64(raw, "base64url");
  return bytes.length === X25519_PUBLIC_KEY_BYTES ? encodeBase64(bytes) : null;
}
