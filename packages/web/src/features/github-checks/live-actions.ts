import { type MachineRpcClient, MachineRpcError } from "@/sync/machineRpc";
import { DaemonUnsupportedError, type GithubChecksActions } from "./types";

/**
 * Adapts a `MachineRpcClient` (`@/sync/machineRpc.ts`) to the
 * `GithubChecksActions` surface the Checks tab consumes — a one-line seam so
 * wiring the real thing in is exactly that: swapping `useMockGithubChecksActions`
 * for `(machineId) => machineRpcToGithubChecksActions(createMachineRpcClient({...}))`.
 * Mirrors `features/git-diff/live-actions.ts`'s `machineRpcToGitDiffActions`.
 *
 * `machineRpc.ts`'s `errorBox` seals `"unknown-method"` as the uniform error
 * for an RPC target an older daemon never registered (`registerMachineRpcHandlers`'s
 * `onRpcRequest`) — caught here and remapped to a typed `DaemonUnsupportedError`
 * so the panel can render "update kvy and restart the daemon" instead of
 * a generic failure.
 */
export function machineRpcToGithubChecksActions(rpc: MachineRpcClient): GithubChecksActions {
  return {
    async fetchChecks(worktree) {
      try {
        return await rpc.call("github.checks", { idempotencyKey: crypto.randomUUID(), worktree });
      } catch (error) {
        if (error instanceof MachineRpcError && error.message === "unknown-method") {
          throw new DaemonUnsupportedError();
        }
        throw error;
      }
    },

    async fetchCheckSteps(worktree, checkName) {
      const result = await rpc.call("github.checkSteps", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
        checkName,
      });
      return result.steps;
    },

    async rerunChecks(worktree) {
      return rpc.call("github.rerunChecks", { idempotencyKey: crypto.randomUUID(), worktree });
    },

    async cancelChecks(worktree) {
      return rpc.call("github.cancelChecks", { idempotencyKey: crypto.randomUUID(), worktree });
    },

    async createPr(worktree) {
      const result = await rpc.call("github.createPr", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
      });
      return result.pr;
    },
  };
}
