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

export function isSignedIn(): boolean {
  return getToken() !== null;
}
