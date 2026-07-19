"use client";

import { SessionListScreen } from "@/features/session-list";

/**
 * The Home screen (design §9.2 "Home" row, falcon-prd.md FR-7.1). Renders
 * real, live session/machine data — `SessionListScreen`'s `useData` defaults
 * to `useLiveSessionListSnapshot` (`features/session-list/live-source.ts`),
 * which reads the sync engine's `['sync']` snapshot and decrypts each
 * session/machine's title client-side; the unmanaged-session section
 * similarly defaults to `useLiveUnmanagedSessions`. Auth-gated by the
 * `(protected)` route group's shared `RequireAuth` boundary.
 */
export default function Home() {
  return <SessionListScreen />;
}
