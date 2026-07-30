import type { MachineRpcClient } from "@/sync/machineRpc";
import type { RepoFileContent, RepoFilesActions } from "./types";

/**
 * Adapts a `MachineRpcClient` (`@/sync/machineRpc.ts`) to the
 * `RepoFilesActions` surface the Repo Files panel consumes — a one-line
 * seam so wiring the real thing in, once a screen has a live `apiSocket` +
 * a crypto client holding the chosen machine's unwrapped DEK, is exactly
 * that: a one-line swap of `useMockRepoFilesActions` for `(machineId) =>
 * machineRpcToRepoFilesActions(createMachineRpcClient({...}))`. Mirrors
 * `features/git-diff/live-actions.ts`'s `machineRpcToGitDiffActions`.
 */
export function machineRpcToRepoFilesActions(rpc: MachineRpcClient): RepoFilesActions {
  return {
    async fetchFileList(worktree) {
      const result = await rpc.call("git.files", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
      });
      return result.files;
    },

    async fetchFileContent(worktree, path, range): Promise<RepoFileContent> {
      const result = await rpc.call("fs.read", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
        path,
        range,
      });
      return { inline: result.inline, blobRef: result.blobRef, truncated: result.truncated };
    },
  };
}
