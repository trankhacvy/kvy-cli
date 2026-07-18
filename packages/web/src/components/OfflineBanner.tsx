"use client";

import { useConnectivity } from "@/lib/use-connectivity";

/**
 * A thin, dismiss-free banner reflecting connectivity (plan-v2.md W4.2
 * "offline banner (`navigator.onLine` + WS state from `apiSocket`)").
 * Mounted once, near the app root (`app/providers.tsx`), so it's visible
 * from every screen without each one wiring it up separately.
 *
 * Two distinct messages, in priority order:
 *  - Browser reports no network at all (`online: false`) — nothing this app
 *    does can fix that, so the copy just says so.
 *  - Browser thinks it's online but the WS transport is down
 *    (`wsConnected: false`) — could be a dropped connection mid-reconnect,
 *    an unreachable server, or a rejected auth; `apiSocket`'s own
 *    infinite-retry engine (`socket-factory.ts`) is already attempting to
 *    recover, so this reads as transient ("Reconnecting…") rather than an
 *    error requiring action.
 *
 * Renders nothing when both signals are healthy — no persistent chrome for
 * the common case.
 */
export function OfflineBanner() {
  const { online, wsConnected } = useConnectivity();

  if (online && wsConnected) return null;

  const message = !online
    ? "You're offline. Changes will sync once your connection returns."
    : "Reconnecting to Falcon…";

  return (
    <div
      role="status"
      className="border-b border-border bg-amber-500/10 px-4 py-1.5 text-center text-xs text-amber-600 dark:text-amber-400"
    >
      {message}
    </div>
  );
}
