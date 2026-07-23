"use client";

import { useMemo } from "react";
import { useMachineCrypto } from "@/lib/use-machine-crypto";
import { apiSocket, createMachineRpcClient } from "@/sync";
import { machineRpcToPreviewActions } from "./live-actions";
import type { PreviewActions, UsePreviewActions } from "./types";

const NOT_READY_MESSAGE = "Machine key isn't unwrapped yet — try again in a moment.";

/** Every method rejects with the same message until `useMachineCrypto`
 * resolves. Structurally satisfies `PreviewActions`, mirroring
 * `features/git-diff/use-live-git-diff-actions.ts`'s
 * `pendingGitDiffActions`. */
function pendingPreviewActions(): PreviewActions {
  const notReady = () => Promise.reject(new Error(NOT_READY_MESSAGE));
  return {
    fetchPorts: notReady,
    fetchTunnels: notReady,
    openTunnel: notReady,
    closeTunnel: notReady,
  };
}

/**
 * The Preview tab's real `UsePreviewActions` — swap-in replacement for
 * `useMockPreviewActions` (`mock-source.ts`) at `PreviewPanel`'s call site.
 * Gated on the shared per-machine DEK unwrap (`@/lib/use-machine-crypto.ts`,
 * the same seam `features/git-diff/use-live-git-diff-actions.ts` uses) so a
 * `preview.*` call never fires before the target machine's key has
 * unwrapped.
 */
export const useLivePreviewActions: UsePreviewActions = (machineId) => {
  const crypto = useMachineCrypto(machineId);

  return useMemo(() => {
    if (!crypto) return pendingPreviewActions();
    return machineRpcToPreviewActions(
      createMachineRpcClient({ socket: apiSocket, crypto, machineId }),
    );
  }, [crypto, machineId]);
};
