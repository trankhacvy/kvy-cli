import type { MachineRpcClient } from "@/sync";
import type { WorkspaceSettingsActions } from "./types.js";

/** Wires `WorkspaceSettingsActions` onto a `MachineRpcClient` — structural clone of `features/run-panel/live-actions.ts`'s `machineRpcToRunPanelActions`. */
export function machineRpcToWorkspaceSettingsActions(
  rpc: MachineRpcClient,
): WorkspaceSettingsActions {
  return {
    async getConfig(worktree) {
      return rpc.call("workspace.getConfig", { idempotencyKey: crypto.randomUUID(), worktree });
    },
    async setConfig(worktree, patch) {
      return rpc.call("workspace.setConfig", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
        ...patch,
      });
    },
    async listBranches(worktree) {
      const result = await rpc.call("git.branches", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
      });
      return result.branches;
    },
    async listRemotes(worktree) {
      const result = await rpc.call("git.remotes", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
      });
      return result.remotes;
    },
  };
}
