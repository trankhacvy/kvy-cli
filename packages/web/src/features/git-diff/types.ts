import type {
  FileStatus,
  GitBranchInfo,
  GitInitResult,
  GitRemoteInfo,
  GitSetRemoteResult,
  GitStatusResult,
} from "@kvy/wire";

/**
 * panel"). Real commit/push/rename write actions and a "compare against
 * any ref" selector landed in docs/features/git-write-actions.md — this is
 * no longer read-only.
 *
 * `GitStatusSnapshot`/`FileStatus`/`GitBranchInfo` are re-exported straight
 * off `@kvy/wire` rather than redeclared: unlike `features/new-session`'s
 * `DirectoryListing` (which flattens the wire shape for the wizard's own
 * convenience), the status/diff/branches RPC results are already exactly
 * what this panel wants to render.
 */
export type GitStatusSnapshot = GitStatusResult;
export type GitFileStatus = FileStatus;
export type { GitBranchInfo };

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
  /** Commits `worktree`'s changes with `message`. `stageAll: true` (the default the panel's toolbar applies) runs `git add -A` first, so the commit includes untracked files too; `false` commits only already-tracked changes (`git commit -a`). `nothingToCommit: true` (with `committed: false`) is the clean no-op outcome, not an error. Throws on any other failure. */
  commit(
    worktree: string,
    message: string,
    options?: { stageAll?: boolean },
  ): Promise<{ committed: boolean; commitSha?: string; nothingToCommit?: boolean }>;
  /** Pushes `worktree`'s current branch. `force: true` maps to `--force-with-lease` (never raw `--force` — see `@kvy/wire`'s `GitPushParamsSchema`). Throws on any failure (including missing/rejected git credentials — surfaced as-is, no Kvy-specific wrapping). */
  push(
    worktree: string,
    options?: { force?: boolean; setUpstream?: boolean },
  ): Promise<{ remote: string; branch: string; forced: boolean }>;
  /** Renames `worktree`'s current branch to `to` (local-only — `git branch -m`). `hadUpstream: true` tells the caller to warn that the remote branch keeps its old name until the next push. Throws on failure (e.g. `to` already exists). */
  renameBranch(worktree: string, to: string): Promise<{ branch: string; hadUpstream: boolean }>;
  /** Lists `worktree`'s local branches — backs the "Compare against" selector's branch options. Throws on failure. */
  listBranches(worktree: string): Promise<GitBranchInfo[]>;
  /** Removes `worktree`'s workspace registration (known-issues.md #3 — the "Remove this workspace" action offered once `fetchStatus`/`fetchDiff` report the folder is gone/no longer a git repo). Idempotent: safe to call even if the entry is already gone. Throws only on a transport/registry-write failure. */
  unregisterWorkspace(worktree: string): Promise<{ ok: boolean }>;
  /** Runs `git init` in `worktree` (the daemon's `git.init` RPC) — the recovery action offered when `fetchStatus` reports `workspace-not-a-repo`. Refusals are result states, not throws: `"already-repo"` (someone else got there first) and `"inside-existing-repo"` (this folder is a subdirectory of another repo; `existingRoot` says which). Throws only on a real failure (unauthorized worktree, git error, unreachable machine). */
  initRepo(worktree: string): Promise<GitInitResult>;
  /** Lists `worktree`'s configured remotes (`git.remotes` — already served by the daemon since the Workspace Settings Git tab landed, just never called from this panel). Backs `push-readiness.ts`'s `"no-remote"` derivation. Throws on failure; an empty array means "no remotes", not an error. */
  listRemotes(worktree: string): Promise<GitRemoteInfo[]>;
  /** Adds (or updates) a remote URL in `worktree` (`git.setRemote`). `name` defaults to `"origin"`. Never removes a remote. Throws on failure. */
  setRemote(worktree: string, url: string, name?: string): Promise<GitSetRemoteResult>;
}

/** One Git-panel actions client per chosen machine — mirrors `UseNewSessionActions = (machineId) => NewSessionActions`. */
export type UseGitDiffActions = (machineId: string) => GitDiffActions;
