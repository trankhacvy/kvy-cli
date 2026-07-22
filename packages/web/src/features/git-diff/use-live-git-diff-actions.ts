"use client";

import { useMemo } from "react";
import { useMachineCrypto } from "@/lib/use-machine-crypto";
import { apiSocket, createMachineRpcClient } from "@/sync";
import { machineRpcToGitDiffActions } from "./live-actions";
import type { GitDiffActions, UseGitDiffActions } from "./types";

const NOT_READY_MESSAGE = "Machine key isn't unwrapped yet — try again in a moment.";

/** Every method rejects with the same message until `useMachineCrypto`
 * resolves. Structurally satisfies `GitDiffActions`, mirroring
 * `features/new-session/live-source.ts`'s `pendingNewSessionActions`. */
function pendingGitDiffActions(): GitDiffActions {
  const notReady = () => Promise.reject(new Error(NOT_READY_MESSAGE));
  return {
    fetchStatus: notReady,
    fetchDiff: notReady,
    commit: notReady,
    push: notReady,
    renameBranch: notReady,
    listBranches: notReady,
  };
}

/**
 * The Git panel's real `UseGitDiffActions` — swap-in replacement for
 * `useMockGitDiffActions` (`mock-source.ts`) at `GitDiffPanel`'s call site.
 * Gated on the shared per-machine DEK unwrap (`@/lib/use-machine-crypto.ts`,
 * the same seam `features/new-session/live-source.ts` uses) so a
 * `git.status`/`git.diff` call never fires before the target machine's key
 * has unwrapped.
 */
export const useLiveGitDiffActions: UseGitDiffActions = (machineId) => {
  const crypto = useMachineCrypto(machineId);

  return useMemo(() => {
    if (!crypto) return pendingGitDiffActions();
    return machineRpcToGitDiffActions(
      createMachineRpcClient({ socket: apiSocket, crypto, machineId }),
    );
  }, [crypto, machineId]);
};
