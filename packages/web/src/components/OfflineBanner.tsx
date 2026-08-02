"use client";

import Link from "next/link";
import { SIGNIN_PATH } from "@/features/auth";
import { useConnectivity } from "@/lib/use-connectivity";

/**
 * Mounted in `app/(protected)/layout.tsx` (not globally) so it never renders on public
 * routes where the WS is not connected and `wsConnected`/`authExpired` carry no signal.
 *
 * Three distinct messages, in priority order:
 *  - `authExpired: true` — server rejected the token; links to sign-in instead of showing
 *    "Reconnecting…" (a reconnect cannot fix an expired session).
 *  - `online: false` — no network; user needs to wait, not act.
 *  - `wsConnected: false` with network present — transient disconnect; `socket-factory.ts`
 *    is already retrying, so the copy says "Reconnecting…".
 *
 * Renders nothing when all signals are healthy.
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
