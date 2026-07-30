"use client";

import type { SessionRow } from "@falcon/wire";
import { useMachineCrypto } from "@/lib/use-machine-crypto";
import { apiSocket, createMachineRpcClient } from "@/sync";

/**
 * Restart (docs/features/session-lifecycle-actions.md Phase 6) — drives the
 * daemon's `resumeSession` machine RPC (`daemon/resumeSession.ts`: kills any
 * still-live process for the session with SIGTERM->SIGKILL escalation, then
 * re-spawns it with `FALCON_RECONNECT_*` env) through the SAME live
 * per-machine crypto + machine-RPC path `features/git-diff`/
 * `features/new-session` already use — `useMachineCrypto` is real and
 * already wired, not gated on separately-tracked transport work (the
 * original solution proposal's "machine-RPC transport gap" blocker was
 * stale by the time this feature's plan was written).
 */

/** Pure enable condition for the Restart menu item, split out so it's
 * directly unit-testable without mounting anything (this package's vitest
 * has no jsdom/RTL, same constraint `session-card-actions-logic.ts`
 * documents) — enabled iff the session has a known owning machine, that
 * machine is currently online, and the session isn't archived (Restore is
 * the only lifecycle action an archived row exposes). */
export function isRestartEnabled(params: {
  machineId: string | null;
  machineOnline: boolean;
  status: SessionRow["status"];
}): boolean {
  return params.machineId !== null && params.machineOnline && params.status !== "archived";
}

/** Why Restart is disabled, for the menu item's `title` hint — `null` when
 * it's actually enabled. Mirrors `isSessionStoppable`'s honest-disabled-
 * reason precedent (`session-card-actions-logic.ts`). */
export function restartDisabledReason(params: {
  machineId: string | null;
  machineOnline: boolean;
  status: SessionRow["status"];
}): string | null {
  if (params.status === "archived") return "Restore this session first";
  if (params.machineId === null) return "This session has no owning machine";
  if (!params.machineOnline) return "This session's machine is offline";
  return null;
}

export interface RestartSessionState {
  /** `true` while the target machine's crypto key is still unwrapping —
   * mirrors `use-live-git-diff-actions.ts`'s own pending-crypto message. */
  pending: boolean;
  /** Calls the `resumeSession` RPC. Rejects immediately (no RPC round-trip)
   * with a visible message if the machine key isn't unwrapped yet; a
   * daemon-side handler-error (e.g. "session not in the durable registry")
   * surfaces via `MachineRpcError`'s message verbatim. */
  restart: () => Promise<{ ok: boolean }>;
}

/** `machineId` may be an empty string transiently (mirrors
 * `use-live-git-diff-actions.ts`'s own `machineId ?? ""` call-site
 * convention) — `useMachineCrypto("")` simply never finds a matching row
 * and stays `null`, which this hook's own `pending`/`restart` handle the
 * same as any other not-ready machine. */
export function useRestartSession(machineId: string, sessionId: string): RestartSessionState {
  const crypto = useMachineCrypto(machineId);

  return {
    pending: crypto === null,
    restart: async () => {
      if (!crypto) {
        throw new Error("Machine key isn't unwrapped yet. Try again in a moment.");
      }
      return createMachineRpcClient({ socket: apiSocket, crypto, machineId }).call(
        "resumeSession",
        { sessionId },
      );
    },
  };
}
