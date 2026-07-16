import type { MachineRpcClient } from "@/sync/machineRpc";
import type { NewSessionActions, SpawnOutcome } from "./types";

/**
 * Adapts a `MachineRpcClient` (`@/sync/machineRpc.ts`) to the
 * `NewSessionActions` surface the wizard consumes — a one-line seam so
 * wiring the real thing in, once a screen has a live `apiSocket` + a
 * crypto client holding the chosen machine's unwrapped DEK, is exactly
 * that: a one-line swap of `useMockNewSessionActions` for `(machineId) =>
 * machineRpcToActions(createMachineRpcClient({...}))`. Mirrors
 * `features/session-control`'s `sessionRpcToActions`.
 *
 * `workspaceId` is set to `directory` itself: there's no workspace
 * registry yet (`packages/cli/src/daemon/workspacePath.ts`'s
 * `resolveWorkspaceRoot` is an injectable seam with no real default —
 * that's separate, later work), so the directory a user picks here stands
 * in as its own stable workspace identity, matching `mock-source.ts`'s
 * arbitrary workspace-id strings elsewhere in this codebase
 * (`features/session-list/mock-source.ts`).
 */
export function machineRpcToActions(rpc: MachineRpcClient): NewSessionActions {
  return {
    async browseDirectory(path) {
      return rpc.call("fs.list", { idempotencyKey: crypto.randomUUID(), path });
    },

    async createDirectory(path) {
      await rpc.call("fs.mkdir", { idempotencyKey: crypto.randomUUID(), path });
    },

    async spawn(request) {
      const result = await rpc.call("spawn", {
        idempotencyKey: crypto.randomUUID(),
        workspaceId: request.directory,
        directory: request.directory,
        provider: request.provider,
        permissionMode: request.permissionMode,
        model: request.model,
        branch: request.branch,
      });

      if (result.sessionId) {
        const outcome: SpawnOutcome = { type: "success", sessionId: result.sessionId };
        return outcome;
      }
      if (result.requiresApproval) {
        const outcome: SpawnOutcome = {
          type: "requiresApproval",
          directory: result.requiresApproval.directory,
        };
        return outcome;
      }
      throw new Error("spawn RPC result carried neither a sessionId nor requiresApproval");
    },
  };
}
