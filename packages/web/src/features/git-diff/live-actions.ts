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

    async commit(worktree, message, options) {
      // One-click commit defaults to staging everything (`git add -A`) so
      // it commits exactly what the panel's changed-files list shows,
      // including untracked files — docs/features/git-write-actions.md's
      // recorded default. `GitToolbar`'s "include untracked" checkbox
      // (defaulting checked) is the primary way a caller overrides this,
      // but the default lives here too so any other caller that omits
      // `stageAll` gets the same one-click behavior.
      return rpc.call("git.commit", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
        message,
        stageAll: options?.stageAll ?? true,
      });
    },

    async push(worktree, options) {
      const result = await rpc.call("git.push", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
        force: options?.force,
        setUpstream: options?.setUpstream,
      });
      return { remote: result.remote, branch: result.branch, forced: result.forced };
    },

    async renameBranch(worktree, to) {
      const result = await rpc.call("git.renameBranch", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
        to,
      });
      return { branch: result.branch, hadUpstream: result.hadUpstream };
    },

    async listBranches(worktree) {
      const result = await rpc.call("git.branches", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
      });
      return result.branches;
    },

    async unregisterWorkspace(worktree) {
      return rpc.call("workspace.unregister", {
        idempotencyKey: crypto.randomUUID(),
        directory: worktree,
      });
    },

    async initRepo(worktree) {
      return rpc.call("git.init", { idempotencyKey: crypto.randomUUID(), worktree });
    },

    async listRemotes(worktree) {
      const result = await rpc.call("git.remotes", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
      });
      return result.remotes;
    },

    async setRemote(worktree, url, name) {
      return rpc.call("git.setRemote", {
        idempotencyKey: crypto.randomUUID(),
        worktree,
        url,
        name,
      });
    },
  };
}
