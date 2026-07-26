/**
 * Preserves a pending `/pair#<ephPub>` visit across a detour through
 * `/signin` — the pairing-approve page (`src/app/pair/page.tsx`) needs an
 * already-authenticated browser, so an unauthenticated visitor is sent to
 * sign in first and must land back on the same pairing request afterward.
 * `sessionStorage` (not `localStorage`): this is a single-visit handoff, not
 * durable state.
 */

const PENDING_PAIR_KEY = "falcon:pendingPair";

export function stashPendingPair(ephPub: string): void {
  window.sessionStorage.setItem(PENDING_PAIR_KEY, ephPub);
}

/** Read without consuming — the sign-in page needs to KNOW a pairing is pending (to
 * change its heading) without spending it. Only the pair page consumes. */
export function peekPendingPair(): string | null {
  return window.sessionStorage.getItem(PENDING_PAIR_KEY);
}

export function consumePendingPair(): string | null {
  const ephPub = window.sessionStorage.getItem(PENDING_PAIR_KEY);
  window.sessionStorage.removeItem(PENDING_PAIR_KEY);
  return ephPub;
}
