"use client";

import { useMemo } from "react";
import { useMachineCrypto } from "@/lib/use-machine-crypto";
import { apiSocket, createMachineRpcClient } from "@/sync";
import { machineRpcToRunPanelActions } from "./live-actions";
import type { RunPanelActions, UseRunPanelActions } from "./types";

const NOT_READY_MESSAGE = "Machine key isn't unwrapped yet. Try again in a moment.";

/** Every method rejects with the same message until `useMachineCrypto`
 * resolves. Structurally satisfies `RunPanelActions`, mirroring
 * `features/git-diff/use-live-git-diff-actions.ts`'s `pendingGitDiffActions`. */
function pendingRunPanelActions(): RunPanelActions {
  const notReady = () => Promise.reject(new Error(NOT_READY_MESSAGE));
  return {
    getConfig: notReady,
    start: notReady,
    stop: notReady,
    status: notReady,
    setup: notReady,
  };
}

/**
 * The Setup/Run panel's real `UseRunPanelActions` — swap-in replacement for
 * `useMockRunPanelActions` (`mock-source.ts`) at `RunPanel`'s call site.
 * Gated on the shared per-machine DEK unwrap (`@/lib/use-machine-crypto.ts`,
 * the same seam `features/git-diff/use-live-git-diff-actions.ts` uses) so a
 * `workspace.getConfig`/`run.*` call never fires before the target
 * machine's key has unwrapped.
 */
export const useLiveRunPanelActions: UseRunPanelActions = (machineId) => {
  const crypto = useMachineCrypto(machineId);

  return useMemo(() => {
    if (!crypto) return pendingRunPanelActions();
    return machineRpcToRunPanelActions(
      createMachineRpcClient({ socket: apiSocket, crypto, machineId }),
    );
  }, [crypto, machineId]);
};
