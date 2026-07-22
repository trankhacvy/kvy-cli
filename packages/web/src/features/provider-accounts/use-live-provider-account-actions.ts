"use client";

import { useMemo } from "react";
import { useMachineCrypto } from "@/lib/use-machine-crypto";
import { apiSocket, createMachineRpcClient } from "@/sync";
import { machineRpcToProviderAccountActions } from "./live-actions";
import type { ProviderAccountActions, UseProviderAccountActions } from "./types";

const NOT_READY_MESSAGE = "Machine key isn't unwrapped yet — try again in a moment.";

/** Rejects with the same message until `useMachineCrypto` resolves. Structurally satisfies `ProviderAccountActions`, mirroring `features/git-diff/use-live-git-diff-actions.ts`'s `pendingGitDiffActions`. */
function pendingProviderAccountActions(): ProviderAccountActions {
  return {
    fetchAccount: () => Promise.reject(new Error(NOT_READY_MESSAGE)),
  };
}

/**
 * Settings → Providers' real `UseProviderAccountActions` — swap-in
 * replacement for `useMockProviderAccountActions` (`mock-source.ts`) at a
 * provider card's call site. Gated on the shared per-machine DEK unwrap
 * (`@/lib/use-machine-crypto.ts`), same precedent as `features/git-diff/
 * use-live-git-diff-actions.ts`'s `useLiveGitDiffActions`.
 */
export const useLiveProviderAccountActions: UseProviderAccountActions = (machineId) => {
  const crypto = useMachineCrypto(machineId);

  return useMemo(() => {
    if (!crypto) return pendingProviderAccountActions();
    return machineRpcToProviderAccountActions(
      createMachineRpcClient({ socket: apiSocket, crypto, machineId }),
    );
  }, [crypto, machineId]);
};
