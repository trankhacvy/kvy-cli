"use client";

import { useEffect, useRef } from "react";

/**
 * Runs `onRecover` exactly on the `machineOnline` false -> true transition —
 * never on mount, never while it stays online the whole time. Shared by
 * every machine-RPC panel hook (`use-git-panel.ts`, `use-repo-files.ts`,
 * `use-run-panel.ts`, `use-preview-panel.ts`, `use-checks-panel.ts`) so a
 * machine coming back online repairs its panel by itself (CLAUDE.md rule #6
 * — "every waiting screen updates itself"): any query that failed while it
 * was offline is now stale-and-wrong, and nothing else would retry it.
 *
 * `machineOnline` defaults to `true` so a caller that doesn't yet know about
 * Feature 2's `useMachineOnline` (or a test harness that never passes it)
 * gets today's behavior — no spurious recovery fetch on mount.
 */
export function useRefetchOnMachineRecovery(machineOnline: boolean, onRecover: () => void): void {
  const wasOffline = useRef(false);
  const onRecoverRef = useRef(onRecover);
  onRecoverRef.current = onRecover;

  useEffect(() => {
    if (!machineOnline) {
      wasOffline.current = true;
      return;
    }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    onRecoverRef.current();
  }, [machineOnline]);
}
