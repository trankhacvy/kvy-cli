"use client";

import { useMemo } from "react";
import { useMachineCrypto } from "@/lib/use-machine-crypto";
import { apiSocket, createMachineRpcClient } from "@/sync";
import { machineRpcToWorkspaceSettingsActions } from "./live-actions.js";
import type { UseWorkspaceSettingsActions, WorkspaceSettingsActions } from "./types.js";

const NOT_READY_MESSAGE = "Machine key isn't unwrapped yet — try again in a moment.";

/** Every method rejects with the same message until `useMachineCrypto`
 * resolves. Structurally satisfies `WorkspaceSettingsActions`, mirroring
 * `features/run-panel/use-live-run-panel-actions.ts`'s `pendingRunPanelActions`. */
function pendingWorkspaceSettingsActions(): WorkspaceSettingsActions {
  const notReady = () => Promise.reject(new Error(NOT_READY_MESSAGE));
  return {
    getConfig: notReady,
    setConfig: notReady,
    listBranches: notReady,
    listRemotes: notReady,
  };
}

/**
 * The Workspace Settings dialog's real `UseWorkspaceSettingsActions`. Gated
 * on the shared per-machine DEK unwrap (`@/lib/use-machine-crypto.ts`) so a
 * `workspace.getConfig`/`workspace.setConfig`/`git.branches`/`git.remotes`
 * call never fires before the target machine's key has unwrapped.
 */
export const useLiveWorkspaceSettingsActions: UseWorkspaceSettingsActions = (machineId) => {
  const crypto = useMachineCrypto(machineId);

  return useMemo(() => {
    if (!crypto) return pendingWorkspaceSettingsActions();
    return machineRpcToWorkspaceSettingsActions(
      createMachineRpcClient({ socket: apiSocket, crypto, machineId }),
    );
  }, [crypto, machineId]);
};
