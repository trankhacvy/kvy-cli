"use client";

import { useMemo } from "react";
import { useMachineCrypto } from "@/lib/use-machine-crypto";
import { apiSocket, createMachineRpcClient } from "@/sync";
import { machineRpcToSlashCommandsActions } from "./live-actions";
import type { SlashCommandsActions, UseSlashCommandsActions } from "./types";

const NOT_READY_MESSAGE = "Machine key isn't unwrapped yet. Try again in a moment.";

/** Rejects with the same message until `useMachineCrypto` resolves.
 * Structurally satisfies `SlashCommandsActions`, mirroring
 * `features/git-diff/use-live-git-diff-actions.ts`'s `pendingGitDiffActions`. */
function pendingSlashCommandsActions(): SlashCommandsActions {
  return {
    listCommands: () => Promise.reject(new Error(NOT_READY_MESSAGE)),
  };
}

/**
 * The composer autocomplete's real `UseSlashCommandsActions` — swap-in
 * replacement for `useMockSlashCommandsActions` (`mock-source.ts`). Gated on
 * the shared per-machine DEK unwrap (`@/lib/use-machine-crypto.ts`), same
 * seam as `features/git-diff/use-live-git-diff-actions.ts`, so a
 * `commands.list` call never fires before the target machine's key has
 * unwrapped.
 */
export const useLiveSlashCommandsActions: UseSlashCommandsActions = (machineId) => {
  const crypto = useMachineCrypto(machineId);

  return useMemo(() => {
    if (!crypto) return pendingSlashCommandsActions();
    return machineRpcToSlashCommandsActions(
      createMachineRpcClient({ socket: apiSocket, crypto, machineId }),
    );
  }, [crypto, machineId]);
};
