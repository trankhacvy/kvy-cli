import { env } from "../../../config.js";
import type { LifecycleKind } from "../types.js";

/**
 * Generic, kind-keyed labels for the text-based fallback channels (Telegram,
 * ntfy) — same content-free rule as Web Push's payload (design §6.4: never
 * session content, since the server holds no keys to encrypt anything richer
 * anyway). Deliberately kept in lockstep with `public/sw.js`'s `KIND_LABELS`
 * — the browser can't share code with the server, so the two copies are
 * kept identical by convention, not by import.
 */
const KIND_LABELS: Record<LifecycleKind, string> = {
  perm: "Kvy needs your permission",
  question: "Kvy has a question for you",
  done: "Kvy finished a task",
  failed: "A Kvy session failed",
};

export function notificationLabel(kind: LifecycleKind): string {
  return KIND_LABELS[kind];
}

/**
 * A deep link into the session, or `null` when the server isn't configured
 * with its public web origin (`PUBLIC_WEB_ORIGIN`) — Telegram/ntfy compose
 * their own message text server-side (unlike webpush, whose service worker
 * already knows its own origin), so they need this to link out at all.
 */
export function notificationDeepLink(sessionId: string): string | null {
  if (!env.PUBLIC_WEB_ORIGIN) return null;
  return new URL(`/dashboard/session/${sessionId}/`, env.PUBLIC_WEB_ORIGIN).toString();
}
