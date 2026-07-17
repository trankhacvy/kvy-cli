import type { MachineRpcClient } from "@/sync/machineRpc";
import type { GitDiffActions } from "./types";

/**
 * Adapts a `MachineRpcClient` (`@/sync/machineRpc.ts`) to the
 * `GitDiffActions` surface the Git panel consumes — a one-line seam so
 * wiring the real thing in, once a screen has a live `apiSocket` + a crypto
 * client holding the chosen machine's unwrapped DEK, is exactly that: a
 * one-line swap of `useMockGitDiffActions` for `(machineId) =>
 * machineRpcToGitDiffActions(createMachineRpcClient({...}))`. Mirrors
 * `features/new-session`'s `machineRpcToActions`.
 */
export function machineRpcToGitDiffActions(rpc: MachineRpcClient): GitDiffActions {
  return {
    async fetchStatus(worktree) {
      return rpc.call("git.status", { idempotencyKey: crypto.randomUUID(), worktree });
    },

    async fetchDiff(worktree, options) {
      const result = await rpc.call("git.diff", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
        path: options?.path,
        baseRef: options?.baseRef,
      });
      return { inline: result.inline, truncated: result.truncated };
    },
  };
}
