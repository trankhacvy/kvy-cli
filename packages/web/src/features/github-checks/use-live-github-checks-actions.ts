"use client";

import { useMemo } from "react";
import { useMachineCrypto } from "@/lib/use-machine-crypto";
import { apiSocket, createMachineRpcClient } from "@/sync";
import { machineRpcToGithubChecksActions } from "./live-actions";
import type { GithubChecksActions, UseGithubChecksActions } from "./types";

const NOT_READY_MESSAGE = "Machine key isn't unwrapped yet. Try again in a moment.";

/** Rejects with the same message until `useMachineCrypto` resolves.
 * Structurally satisfies `GithubChecksActions`, mirroring
 * `features/git-diff/use-live-git-diff-actions.ts`'s `pendingGitDiffActions`. */
function pendingGithubChecksActions(): GithubChecksActions {
  return { fetchChecks: () => Promise.reject(new Error(NOT_READY_MESSAGE)) };
}

/**
 * The Checks tab's real `UseGithubChecksActions` — swap-in replacement for
 * `useMockGithubChecksActions` (`mock-source.ts`) at `ChecksPanel`'s call
 * site. Gated on the shared per-machine DEK unwrap (`@/lib/
 * use-machine-crypto.ts`, the same seam `features/git-diff/
 * use-live-git-diff-actions.ts` uses) so a `github.checks` call never fires
 * before the target machine's key has unwrapped.
 */
export const useLiveGithubChecksActions: UseGithubChecksActions = (machineId) => {
  const crypto = useMachineCrypto(machineId);

  return useMemo(() => {
    if (!crypto) return pendingGithubChecksActions();
    return machineRpcToGithubChecksActions(
      createMachineRpcClient({ socket: apiSocket, crypto, machineId }),
    );
  }, [crypto, machineId]);
};
