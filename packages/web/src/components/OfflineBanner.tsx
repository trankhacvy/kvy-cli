"use client";

import Link from "next/link";
import { SIGNIN_PATH } from "@/features/auth";
import { useConnectivity } from "@/lib/use-connectivity";

/**
 * A thin, dismiss-free banner reflecting connectivity (plan-v2.md W4.2
 * "offline banner (`navigator.onLine` + WS state from `apiSocket`)").
 * Mounted once, in `app/(protected)/layout.tsx` — not globally in
 * `app/providers.tsx`, where it used to live — so it's visible from every
 * authenticated screen without each one wiring it up separately, and never
 * renders on a public route (`/signin/`, `/pair/`, `/auth/callback/*`),
 * where `apiSocket.connect()` is never called and `wsConnected`/
 * `authExpired` would never reflect anything real (known-issues.md
 * "OfflineBanner shows a misleading 'Reconnecting…' on pages with no
 * connection to reconnect").
 *
 * Three distinct messages, in priority order:
 *  - The server has rejected the current token (`authExpired: true`,
 *    bug-fix-plan.md issue #10) — a permanent condition no amount of
 *    reconnect-waiting fixes, so this branches *before* the generic
 *    "Reconnecting…" copy and links straight to `/signin/` instead.
 *  - Browser reports no network at all (`online: false`) — nothing this app
 *    does can fix that, so the copy just says so.
 *  - Browser thinks it's online but the WS transport is down
 *    (`wsConnected: false`) — could be a dropped connection mid-reconnect or
 *    an unreachable server; `apiSocket`'s own infinite-retry engine
 *    (`socket-factory.ts`) is already attempting to recover, so this reads
 *    as transient ("Reconnecting…") rather than an error requiring action.
 *
 * Renders nothing when every signal is healthy — no persistent chrome for
 * the common case.
 */
export function OfflineBanner() {
  const { online, wsConnected, authExpired } = useConnectivity();

  if (authExpired) {
    return (
      <div
        role="status"
        className="border-b border-border bg-amber-500/10 px-4 py-1.5 text-center text-xs text-amber-600 dark:text-amber-400"
      >
        Your session expired.{" "}
        <Link href={SIGNIN_PATH} className="underline">
          Sign in again
        </Link>
        .
      </div>
    );
  }

  if (online && wsConnected) return null;

  const message = !online
    ? "You're offline. Changes will sync once your connection returns."
    : "Reconnecting to Kvy…";

  return (
    <div
      role="status"
      className="border-b border-border bg-amber-500/10 px-4 py-1.5 text-center text-xs text-amber-600 dark:text-amber-400"
    >
      {message}
    </div>
  );
}
