"use client";

import { useEffect, useState } from "react";

/**
 * Whole seconds elapsed since `startedAt` (ms epoch), ticking once a second
 * while `active` — the one real, honest timing signal available client-side
 * for the spawn RPC's wait (B4). The `spawn` RPC is a single request/ack
 * over the encrypted machine-RPC channel (`sync/machineRpc.ts`), not a
 * stream — the daemon reports no intermediate stage events back to the web
 * client while a spawn is in flight (`spawnEngine.ts`'s `spawnSession`
 * either resolves once, or rejects once; `spawnAwaiter.ts`'s wait tops out
 * at `DEFAULT_SPAWN_AWAITER_TIMEOUT_MS`, 15s, plus whatever branch/worktree
 * setup and process-launch time came before that wait even started). So
 * this deliberately does NOT fabricate named progress stages ("Creating
 * worktree… Launching… Waiting for session…") the client has no real signal
 * to back — it only ever shows elapsed wall-clock time, which is something
 * this hook can actually measure. `null` while inactive (nothing to show).
 */
export function useElapsedSeconds(active: boolean, startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || startedAt === null) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [active, startedAt]);

  if (!active || startedAt === null) return null;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}
