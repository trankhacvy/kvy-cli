"use client";

import { useMemo } from "react";
import { useMachineCrypto } from "@/lib/use-machine-crypto";
import { apiSocket, createMachineRpcClient } from "@/sync";
import { machineRpcToRepoFilesActions } from "./live-actions";
import type { RepoFilesActions, UseRepoFilesActions } from "./types";

const NOT_READY_MESSAGE = "Machine key isn't unwrapped yet — try again in a moment.";

/** Every method rejects with the same message until `useMachineCrypto`
 * resolves. Structurally satisfies `RepoFilesActions`, mirroring
 * `features/git-diff/use-live-git-diff-actions.ts`'s `pendingGitDiffActions`. */
function pendingRepoFilesActions(): RepoFilesActions {
  const notReady = () => Promise.reject(new Error(NOT_READY_MESSAGE));
  return {
    fetchFileList: notReady,
    fetchFileContent: notReady,
  };
}

/**
 * The Repo Files panel's real `UseRepoFilesActions` — swap-in replacement
 * for `useMockRepoFilesActions` (`mock-source.ts`) at `RepoFilesPanel`'s
 * call site. Gated on the shared per-machine DEK unwrap
 * (`@/lib/use-machine-crypto.ts`, the same seam `features/git-diff` uses)
 * so a `git.files`/`fs.read` call never fires before the target machine's
 * key has unwrapped.
 */
export const useLiveRepoFilesActions: UseRepoFilesActions = (machineId) => {
  const crypto = useMachineCrypto(machineId);

  return useMemo(() => {
    if (!crypto) return pendingRepoFilesActions();
    return machineRpcToRepoFilesActions(
      createMachineRpcClient({ socket: apiSocket, crypto, machineId }),
    );
  }, [crypto, machineId]);
};
