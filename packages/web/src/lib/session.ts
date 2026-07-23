/**
 * Bearer-token storage. The JWT (design §5.2: "1 h, auto-refresh") is not key
 * material — it's a scoped, revocable credential (design §12) — so it's fine
 * in `localStorage`, unlike the master secret, which never leaves the crypto
 * worker/IndexedDB (`src/crypto/`). Guarded for SSR/build time, where
 * `localStorage` doesn't exist: Next prerenders these pages at build time
 * (static export), and every call here happens inside a "use client"
 * component's effect/handler, but guarding costs nothing and avoids a hard
 * crash if that ever changes.
 */

const TOKEN_KEY = "falcon:token";

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getToken(): string | null {
  if (!hasLocalStorage()) return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (!hasLocalStorage()) return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (!hasLocalStorage()) return;
  window.localStorage.removeItem(TOKEN_KEY);
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
