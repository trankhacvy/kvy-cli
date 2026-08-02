/**
 * Per-device "last seen" timestamps, one per session — the missing half of
 * last-seen timestamps"). `localStorage` is the right store here (unlike
 * the master secret in `@/crypto`): it's inherently per-device, and losing
 * it just means a completed turn briefly re-shows as unseen — never a
 * security or correctness issue (design principle #3: derived, never
 * authoritative). Guarded for SSR/build time the same way `lib/session.ts`
 * is — Next prerenders these routes at build time (static export).
 */

const PREFIX = "kvy:last-seen:";

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/** `null` means "never seen on this device" — treat every closed turn as unseen. */
export function getLastSeenAt(sessionId: string): number | null {
  if (!hasLocalStorage()) return null;
  const raw = window.localStorage.getItem(PREFIX + sessionId);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Marks `sessionId` as seen right now — call whenever the user is actively
 * looking at its timeline (mount, tab focus). */
export function markSeenNow(sessionId: string, now: number = Date.now()): void {
  if (!hasLocalStorage()) return;
  window.localStorage.setItem(PREFIX + sessionId, String(now));
}
