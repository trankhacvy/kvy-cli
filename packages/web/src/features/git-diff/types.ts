import type { FileStatus, GitStatusResult } from "@falcon/wire";

/**
 * View-model types for the Git panel (falcon-system-design.md §4.4
 * `git.status`/`git.diff`; falcon-prd.md FR-7.7 "file-level diff list vs
 * configured base ref, per-file unified diff view"; plan.md §16 "4.1 Git
 * panel"). Read-only for the MVP — no commit/push/PR actions here.
 *
 * `GitStatusSnapshot`/`FileStatus` are re-exported straight off
 * `@falcon/wire` rather than redeclared: unlike `features/new-session`'s
 * `DirectoryListing` (which flattens the wire shape for the wizard's own
 * convenience), the status/diff RPC results are already exactly what this
 * panel wants to render.
 */
export type GitStatusSnapshot = GitStatusResult;
export type GitFileStatus = FileStatus;

export interface GitDiffContent {
  /** The unified diff text (possibly truncated — see `truncated`); absent only if a future blob-backed fetch hasn't resolved it inline yet. */
  inline?: string;
  truncated: boolean;
}

/**
 * The RPC surface the Git panel needs, seamed off from *how* those calls
 * reach the daemon — mirrors `features/new-session`'s `NewSessionActions` /
 * `features/session-control`'s `SessionControlActions` pattern. Mock by
 * default (`mock-source.ts`), swapped for
 * `machineRpcToGitDiffActions(createMachineRpcClient({...}))`
 * (`live-actions.ts`) once a screen has a live `apiSocket` + a crypto
 * client holding the target machine's unwrapped DEK.
 */
export interface GitDiffActions {
  /** Fetches the changed-files list for `worktree`. Throws on failure (not a git repo, unreachable machine, ...). */
  fetchStatus(worktree: string): Promise<GitStatusSnapshot>;
  /** Fetches a unified diff for `worktree`, optionally scoped to one `path`, against `baseRef` (falls back to the workspace's configured base ref, then `HEAD`, when omitted — see `daemon/gitDiff.ts`). Throws on failure. */
  fetchDiff(
    worktree: string,
    options?: { path?: string; baseRef?: string },
  ): Promise<GitDiffContent>;
}

/** One Git-panel actions client per chosen machine — mirrors `UseNewSessionActions = (machineId) => NewSessionActions`. */
export type UseGitDiffActions = (machineId: string) => GitDiffActions;
