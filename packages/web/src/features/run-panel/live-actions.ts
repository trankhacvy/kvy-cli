import type { MachineRpcClient } from "@/sync/machineRpc";
import type { RunPanelActions } from "./types";

/**
 * Adapts a `MachineRpcClient` (`@/sync/machineRpc.ts`) to the
 * `RunPanelActions` surface the Setup/Run panel consumes — a one-line seam
 * so wiring the real thing in, once a screen has a live `apiSocket` + a
 * crypto client holding the chosen machine's unwrapped DEK, is exactly
 * that: a one-line swap of `useMockRunPanelActions` for
 * `useLiveRunPanelActions`. Mirrors `features/git-diff/live-actions.ts`'s
 * `machineRpcToGitDiffActions` — mints a fresh `idempotencyKey` per
 * mutation, `worktree` is the only params field either surface ever needs.
 */
export function machineRpcToRunPanelActions(rpc: MachineRpcClient): RunPanelActions {
  return {
    async getConfig(worktree) {
      return rpc.call("workspace.getConfig", { idempotencyKey: crypto.randomUUID(), worktree });
    },

    async start(worktree) {
      return rpc.call("run.start", { idempotencyKey: crypto.randomUUID(), worktree });
    },

    async stop(worktree) {
      return rpc.call("run.stop", { idempotencyKey: crypto.randomUUID(), worktree });
    },

    async status(worktree) {
      return rpc.call("run.status", { idempotencyKey: crypto.randomUUID(), worktree });
    },

    async setup(worktree) {
      return rpc.call("run.setup", { idempotencyKey: crypto.randomUUID(), worktree });
    },
  };
}
