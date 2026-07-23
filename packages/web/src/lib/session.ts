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
import { refreshSession } from "./api.js";

const TOKEN_KEY = "falcon:token";
// issue-4-plan.md §6.4: the refresh token is the actual long-lived credential now (60-day
// absolute lifetime, §4.6) — the access token above is short-lived (15m, §8 Phase 6) and
// silently re-minted from this one. Same `localStorage` custody as the access token: it's
// a scoped, revocable, hashed-server-side credential, not key material (that stays in
// IndexedDB via the crypto worker, untouched by this file).
const REFRESH_TOKEN_KEY = "falcon:refreshToken";

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

export function getRefreshToken(): string | null {
  if (!hasLocalStorage()) return null;
  return window.localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setRefreshToken(refreshToken: string): void {
  if (!hasLocalStorage()) return;
  window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearRefreshToken(): void {
  if (!hasLocalStorage()) return;
  window.localStorage.removeItem(REFRESH_TOKEN_KEY);
}

/** Stores both halves of a freshly-issued or freshly-rotated session (§4.2/§4.3). */
export function setSession(tokens: { accessToken: string; refreshToken: string }): void {
  setToken(tokens.accessToken);
  setRefreshToken(tokens.refreshToken);
}

export function clearSession(): void {
  clearToken();
  clearRefreshToken();
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
 * issue-4-plan.md §6.4: attempt one silent refresh using the stored refresh token —
 * `require-auth.tsx` calls this before redirecting to `/signin/` on an expired/missing
 * access token, and `apiSocket.ts` calls it on an auth `connect_error`, so a normal
 * 15-minute access-token boundary never forces a visible re-login. Resolves `false`
 * (and clears the session) when there's no refresh token to try, or the server rejects
 * it (dead/revoked) — the caller is then responsible for redirecting to sign-in.
 */
export async function silentRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  try {
    const tokens = await refreshSession(refreshToken);
    setSession(tokens);
    return true;
  } catch {
    clearSession();
    return false;
  }
}
