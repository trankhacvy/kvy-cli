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
 * `workspaceId` is set to `directory` itself: a workspace's `workspaceId`
 * *is* its registered (real, symlink-resolved) directory path
 * (`packages/cli/src/workspace/registry.ts`'s own module doc), matching
 * `mock-source.ts`'s arbitrary workspace-id strings elsewhere in this
 * codebase (`features/session-list/mock-source.ts`). `listImportCandidates`
 * reuses the same convention for `adopt.list`'s own `workspaceId` param.
 *
 * A genuinely fresh directory — picked cold in the wizard, never
 * `falcon workspace register`'d from a terminal — is not yet in that
 * registry, so `spawn` resolves with a `register-workspace` approval
 * (plan.md §16 "Flow 3 — spawn-fresh-folder-register (Piece A)") instead of
 * throwing `unknown-workspace`; `registerWorkspace` below (the new
 * `workspace.register` RPC) is what `spawn-flow.ts`'s `runSpawnFlow` calls
 * to resolve that, mirroring `createDirectory`/`create-directory` exactly.
 */
export function machineRpcToActions(rpc: MachineRpcClient): NewSessionActions {
  return {
    async browseDirectory(path) {
      return rpc.call("fs.list", { idempotencyKey: crypto.randomUUID(), path });
    },

    async createDirectory(path) {
      await rpc.call("fs.mkdir", { idempotencyKey: crypto.randomUUID(), path });
    },

    async registerWorkspace(directory) {
      await rpc.call("workspace.register", { idempotencyKey: crypto.randomUUID(), directory });
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
        continueFrom: request.continueFrom,
      });

      if (result.sessionId) {
        const outcome: SpawnOutcome = { type: "success", sessionId: result.sessionId };
        return outcome;
      }
      if (result.requiresApproval) {
        const outcome: SpawnOutcome = {
          type: "requiresApproval",
          action: result.requiresApproval.action,
          directory: result.requiresApproval.directory,
        };
        return outcome;
      }
      throw new Error("spawn RPC result carried neither a sessionId nor requiresApproval");
    },

    async listImportCandidates(directory) {
      const result = await rpc.call("adopt.list", {
        idempotencyKey: crypto.randomUUID(),
        workspaceId: directory,
      });
      return result.items;
    },
  };
}
