/**
 * Unverified JWT payload decoding for display purposes only (`falcon auth
 * status`). The CLI has no way to verify the server's HS256 signature (it
 * doesn't hold `FALCON_MASTER_SECRET`, and rightly so) — this only reads the
 * `sub`/`exp` claims to show the user something informative. It must NEVER
 * be used to make an authorization decision; the server is the only party
 * that verifies tokens (`packages/server/src/auth/tokens.ts`).
 */

export interface UnverifiedTokenClaims {
  accountId: string;
  expiresAt: number; // epoch seconds
}

function decodeBase64UrlJson(segment: string): unknown {
  const padded = segment.replaceAll("-", "+").replaceAll("_", "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return JSON.parse(Buffer.from(padded + pad, "base64").toString("utf8"));
}

/** Returns null for any malformed/non-JWT input — never throws. */
export function decodeTokenClaimsUnverified(token: string): UnverifiedTokenClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = decodeBase64UrlJson(parts[1] as string);
    if (typeof payload !== "object" || payload === null) return null;
    const { sub, exp } = payload as Record<string, unknown>;
    if (typeof sub !== "string" || sub.length === 0) return null;
    if (typeof exp !== "number") return null;
    return { accountId: sub, expiresAt: exp };
  } catch {
    return null;
  }
}
