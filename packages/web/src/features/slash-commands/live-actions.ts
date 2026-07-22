import type { MachineRpcClient } from "@/sync/machineRpc";
import type { SlashCommandsActions } from "./types";

/**
 * Adapts a `MachineRpcClient` (`@/sync/machineRpc.ts`) to the
 * `SlashCommandsActions` surface the composer's autocomplete consumes —
 * mirrors `features/git-diff/live-actions.ts`'s `machineRpcToGitDiffActions`
 * one-line-seam shape exactly.
 */
export function machineRpcToSlashCommandsActions(rpc: MachineRpcClient): SlashCommandsActions {
  return {
    async listCommands(worktree) {
      const result = await rpc.call("commands.list", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
      });
      return result.commands;
    },
  };
}
