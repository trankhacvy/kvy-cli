import type { GitBranchInfo, GitRemoteInfo } from "@falcon/wire";
import { useMemo } from "react";
import type { GitDiffActions, GitDiffContent, GitStatusSnapshot, UseGitDiffActions } from "./types";

/**
 * The Git panel's default data source — mirrors `features/new-session/
 * mock-source.ts`'s role: `apiSocket`/a live per-machine crypto client
 * aren't wired into a screen yet, so this simulates the daemon's
 * `git.status`/`git.diff` RPCs against a small fixed changed-files set, kept
 * to the same call signatures (`GitDiffActions`) so swapping in the real
 * `machineRpcToGitDiffActions` later is a one-line change at the call site.
 */

const LATENCY_MS = 200;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MOCK_STATUS: GitStatusSnapshot = {
  branch: "feature/git-panel",
  ahead: 3,
  behind: 1,
  files: [
    { path: "packages/web/src/features/git-diff/types.ts", status: "added", insertions: 42 },
    { path: "packages/web/src/features/git-diff/live-actions.ts", status: "added", insertions: 58 },
    { path: "packages/cli/src/daemon/gitDiff.ts", status: "added", insertions: 76 },
    { path: "packages/wire/src/rpc.ts", status: "modified", insertions: 12, deletions: 3 },
    {
      path: "packages/cli/src/daemon/machineRpc.ts",
      status: "modified",
      insertions: 5,
      deletions: 2,
    },
    { path: "packages/cli/src/daemon/gitWorktree.test.ts", status: "deleted", deletions: 30 },
  ],
};

const MOCK_DIFFS: Record<string, string> = {
  "packages/web/src/features/git-diff/types.ts": [
    "diff --git a/packages/web/src/features/git-diff/types.ts b/packages/web/src/features/git-diff/types.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/packages/web/src/features/git-diff/types.ts",
    "@@ -0,0 +1,4 @@",
    "+export interface GitDiffActions {",
    "+  fetchStatus(worktree: string): Promise<unknown>;",
    "+  fetchDiff(worktree: string): Promise<unknown>;",
    "+}",
    "",
  ].join("\n"),
  "packages/wire/src/rpc.ts": [
    "diff --git a/packages/wire/src/rpc.ts b/packages/wire/src/rpc.ts",
    "index 2222222..3333333 100644",
    "--- a/packages/wire/src/rpc.ts",
    "+++ b/packages/wire/src/rpc.ts",
    "@@ -120,6 +120,7 @@ export const GitDiffResultSchema = z.object({",
    " export const GitDiffResultSchema = z.object({",
    "   inline: z.string().optional(),",
    "   blobRef: z.string().optional(),",
    "+  truncated: z.boolean(),",
    " });",
    "",
  ].join("\n"),
  "packages/cli/src/daemon/gitWorktree.test.ts": [
    "diff --git a/packages/cli/src/daemon/gitWorktree.test.ts b/packages/cli/src/daemon/gitWorktree.test.ts",
    "deleted file mode 100644",
    "index 4444444..0000000",
    "--- a/packages/cli/src/daemon/gitWorktree.test.ts",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    "-import { describe } from 'vitest';",
    "-",
    "-describe.skip('placeholder', () => {});",
    "",
  ].join("\n"),
};

const MOCK_BRANCHES: GitBranchInfo[] = [
  { name: MOCK_STATUS.branch, isCurrent: true, upstream: `origin/${MOCK_STATUS.branch}` },
  { name: "main", isCurrent: false, upstream: "origin/main" },
  { name: "wf/other-task", isCurrent: false },
];

const MOCK_REMOTES: GitRemoteInfo[] = [{ name: "origin", url: "git@github.com:falcon/falcon.git" }];

function defaultDiffFor(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 5555555..6666666 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,2 +1,2 @@",
    "-// before",
    "+// after (mock diff: a live machine RPC hasn't been wired into this screen yet)",
    " // unchanged context line",
    "",
  ].join("\n");
}

export function createMockGitDiffActions(_machineId: string): GitDiffActions {
  // Mutable, per-instance copy so `setRemote` demos its add/update behavior
  // without touching the shared `MOCK_REMOTES` fixture — mirrors
  // `features/new-session/mock-source.ts`'s `createDirectory` mutating its
  // own in-memory tree rather than a shared one.
  const remotes: GitRemoteInfo[] = MOCK_REMOTES.map((r) => ({ ...r }));

  return {
    async fetchStatus(_worktree) {
      await delay(LATENCY_MS);
      return MOCK_STATUS;
    },

    async fetchDiff(_worktree, options): Promise<GitDiffContent> {
      await delay(LATENCY_MS);
      const path = options?.path;
      const inline = path
        ? (MOCK_DIFFS[path] ?? defaultDiffFor(path))
        : Object.values(MOCK_DIFFS).join("");
      return { inline, truncated: false };
    },

    async commit(_worktree, _message, _options) {
      await delay(LATENCY_MS);
      return { committed: true, commitSha: "abc1234" };
    },

    async push(_worktree, options) {
      await delay(LATENCY_MS);
      return { remote: "origin", branch: MOCK_STATUS.branch, forced: options?.force === true };
    },

    async renameBranch(_worktree, to) {
      await delay(LATENCY_MS);
      return { branch: to, hadUpstream: true };
    },

    async listBranches(_worktree) {
      await delay(LATENCY_MS);
      return MOCK_BRANCHES;
    },

    async unregisterWorkspace(_worktree) {
      await delay(LATENCY_MS);
      return { ok: true };
    },

    async initRepo(_worktree) {
      await delay(LATENCY_MS);
      // The mock's `fetchStatus` always succeeds — there's no "not a repo"
      // state to simulate flipping out of, so the honest mock answer is the
      // idempotent no-op state a real already-initialized repo would report.
      return { state: "already-repo", branch: MOCK_STATUS.branch };
    },

    async listRemotes(_worktree) {
      await delay(LATENCY_MS);
      return remotes.map((r) => ({ ...r }));
    },

    async setRemote(_worktree, url, name) {
      await delay(LATENCY_MS);
      const remoteName = name ?? "origin";
      const existing = remotes.find((r) => r.name === remoteName);
      if (existing) {
        existing.url = url;
        return { ok: true, name: remoteName, url, created: false };
      }
      remotes.push({ name: remoteName, url });
      return { ok: true, name: remoteName, url, created: true };
    },
  };
}

/** `useMemo`'d on `machineId` so a real hook backed by a live `GitDiffActions` client (which shouldn't reseal/reconnect every render) can be swapped in without changing this call site's shape. */
export const useMockGitDiffActions: UseGitDiffActions = (machineId) =>
  useMemo(() => createMockGitDiffActions(machineId), [machineId]);
