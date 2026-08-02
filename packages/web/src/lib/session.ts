/**
 * Access-token storage.
 *
 * Neither token lives in `localStorage`:
 *
 * - The refresh token only exists PIN-wrapped in IndexedDB or briefly unwrapped in the
 *   crypto worker's memory - never on the main thread. Recovering it and minting a fresh
 *   access token both happen inside the worker; only the resulting access token crosses out.
 * - The access token is kept as a plain in-memory module variable (cheap to re-mint at 15m
 *   TTL). A same-page XSS can still read this variable, but it no longer persists across
 *   reloads as `localStorage` did, and it is never the long-lived credential.
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
 * (UX reads only; the server is the security boundary). Returns `null` for
 * anything that doesn't parse. */
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
 * Attempt one silent refresh via the crypto worker's own refresh token.
 *
 * Tri-state, not boolean: collapsing "the server rejected the credential" with
 * "the request never got anywhere" would turn a transient network failure into a
 * sign-out. Only `"signed-out"` should redirect to sign-in; `"unreachable"` means
 * keep the session and let the caller retry.
 */
export type SilentRefreshResult = "ok" | "signed-out" | "unreachable";

export async function silentRefresh(): Promise<SilentRefreshResult> {
  const bridge = getSharedCryptoBridge();
  // No live worker to ask. Not evidence of a dead session — leave the token alone, same
  // as this function always has.
  if (!bridge) return "unreachable";

  const outcome = await bridge.refreshSession();
  switch (outcome.kind) {
    case "ok":
      setToken(outcome.accessToken);
      return "ok";
    case "no-credential":
    case "rejected":
      clearToken();
      return "signed-out";
    case "unreachable":
      return "unreachable";
  }
}
