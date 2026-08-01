/**
 * Per-session composer draft persistence (plan-v2.md W4.2 "draft persistence
 * (sessionStorage keyed by sessionId)"). `sessionStorage`, not
 * `localStorage`, is the right store here — a draft is a "you were mid-typing
 * when you navigated/reloaded this tab" convenience, not something that
 * should survive across browser sessions or resurface on a different device
 * (unlike `last-seen.ts`'s per-device-forever attention timestamps). Guarded
 * for SSR/build time the same way `last-seen.ts`/`lib/session.ts` are — Next
 * prerenders these routes at build time (static export), where `window`
 * doesn't exist.
 */

const PREFIX = "kvy:composer-draft:";

function hasSessionStorage(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

/** `""` means "no saved draft" — same as a genuinely empty composer, so
 * callers never need to distinguish the two. */
export function loadDraft(sessionId: string): string {
  if (!hasSessionStorage()) return "";
  return window.sessionStorage.getItem(PREFIX + sessionId) ?? "";
}

/** Saves `text` as `sessionId`'s draft, or clears it entirely once `text`
 * trims to empty — an empty draft left behind would otherwise linger as a
 * phantom entry `sessionStorage` never needs to hold. */
export function saveDraft(sessionId: string, text: string): void {
  if (!hasSessionStorage()) return;
  const key = PREFIX + sessionId;
  if (text.trim().length === 0) {
    window.sessionStorage.removeItem(key);
    return;
  }
  window.sessionStorage.setItem(key, text);
}

/** Clears `sessionId`'s draft outright — called right after a successful
 * send, since the just-sent text is no longer "in progress". */
export function clearDraft(sessionId: string): void {
  if (!hasSessionStorage()) return;
  window.sessionStorage.removeItem(PREFIX + sessionId);
}
