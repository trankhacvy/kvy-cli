/**
 * Access-token storage.
 *
 * Security review finding F1: this used to also store the 60-day refresh token in
 * `localStorage` — fully XSS-readable, which undid the whole point of the 15-minute
 * access-token hardening (an XSS stealing a single `localStorage` read gets a
 * long-lived, full-account credential). Neither token lives in `localStorage` anymore:
 *
 *   - The refresh token only ever exists PIN-wrapped in IndexedDB (`crypto/key-storage.ts`'s
 *     `StoredKeyRecord.wrappedRefreshToken`) or, briefly, unwrapped in the crypto worker's
 *     own memory (`crypto/worker-handler.ts`) — never in this module, never on the main
 *     thread at all. Recovering it (via a PIN unlock) and minting a fresh access token from
 *     it both happen inside the worker (`refreshSession()`); only the resulting access
 *     token crosses back out.
 *   - The access token is kept here as a plain in-memory module variable — cheap to
 *     re-mint (15m TTL, `refreshSession()` handles it) and, being main-thread state, wiped
 *     by any full page reload the same way `localStorage` used to persist through. This is
 *     a real, accepted trade — a same-page XSS with arbitrary code execution can still read
 *     this variable (or simply hook `fetch`), same as it always could regardless of storage
 *     location — but it's no longer sitting somewhere that persists across reloads/sessions
 *     for a passive read to find, and it's never the 60-day credential.
 */
import { getSharedCryptoBridge } from "./use-crypto-bridge.js";

let inMemoryAccessToken: string | null = null;

export function getToken(): string | null {
  return inMemoryAccessToken;
}

export function setToken(token: string): void {
  inMemoryAccessToken = token;
}

export function clearToken(): void {
  inMemoryAccessToken = null;
}

/** Base64url-decodes a JWT's payload segment — no signature verification
 * (these are UX reads, not a security boundary; the server is the actual
 * authority, see docs/bug-fix-plan.md issue #9). Returns `null` for anything
 * that doesn't parse: not exactly 3 dot-separated segments, non-base64
 * payload, or non-JSON payload. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  const payloadPart = parts[1];
  if (parts.length !== 3 || !payloadPart) return null;
  try {
    const payloadJson = atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/"));
    const payload: unknown = JSON.parse(payloadJson);
    if (typeof payload !== "object" || payload === null) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Reads the stored token's `exp` claim, or `null` if missing/non-numeric
 * (see `decodeJwtPayload`). */
function decodeJwtExp(token: string): number | null {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" ? exp : null;
}

/** The account id the stored token was minted for (JWT `sub` — the only
 * identity claim the server puts in the token, see
 * `server/src/auth/tokens.ts`), or `null` when signed out / unparsable. Used
 * for display only (the sidebar's account footer). */
export function getAccountId(): string | null {
  const token = getToken();
  if (!token) return null;
  const sub = decodeJwtPayload(token)?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : null;
}

/** True once the stored token's own `exp` claim has passed (or is unparsable
 * — treated as expired rather than silently trusted, per this codebase's "no
 * silent failures" principle). `null`/no-token also returns `true` (nothing
 * valid to trust). */
export function isTokenExpired(): boolean {
  const token = getToken();
  if (!token) return true;
  const exp = decodeJwtExp(token);
  if (exp === null) return true;
  return Date.now() >= exp * 1000;
}

export function isSignedIn(): boolean {
  return getToken() !== null && !isTokenExpired();
}

/**
 * issue-4-plan.md §6.4 / security review F1: attempt one silent refresh via the crypto
 * worker's own (PIN-recovered, never-persisted-in-plaintext) refresh token —
 * `require-auth.tsx` calls this once the worker is confirmed unlocked, and
 * `apiSocket.ts` calls it on an auth `connect_error`, so a normal 15-minute
 * access-token boundary never forces a visible re-login. Resolves `false` (and clears
 * the in-memory access token) when there's no unlocked bridge to ask, no refresh token
 * recovered into it, or the server rejects the refresh (dead/revoked) — the caller is
 * then responsible for redirecting to sign-in.
 */
export async function silentRefresh(): Promise<boolean> {
  const bridge = getSharedCryptoBridge();
  if (!bridge) return false;

  const accessToken = await bridge.refreshSession();
  if (!accessToken) {
    clearToken();
    return false;
  }
  setToken(accessToken);
  return true;
}
