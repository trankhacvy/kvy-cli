import type { FsReadResult } from "@falcon/wire";

/**
 * View-model types for the Repo Files panel (falcon-system-design.md §4.4
 * `git.files`/`fs.read`; docs/competitive-notes-omnara.md #5 "Full repo
 * file browser": "browses and displays any file in the repo (full
 * syntax-highlighted viewer, line numbers), not just files with diffs — a
 * read-only code viewer with no separate editor needed"). Read-only, same
 * as `features/git-diff` — no save/edit actions here.
 */

/** The unified file-content shape both a fresh `fs.read` and its mock share — same "possibly truncated" contract as `features/git-diff`'s `GitDiffContent`. */
export type RepoFileContent = FsReadResult;

/**
 * The RPC surface the Repo Files panel needs, seamed off from *how* those
 * calls reach the daemon — mirrors `features/git-diff`'s `GitDiffActions`.
 * Mock by default (`mock-source.ts`), swapped for
 * `machineRpcToRepoFilesActions(createMachineRpcClient({...}))`
 * (`live-actions.ts`) once a screen has a live `apiSocket` + a crypto client
 * holding the target machine's unwrapped DEK.
 */
export interface RepoFilesActions {
  /** Fetches the flat, worktree-relative file list for `worktree` (`git.files` — tracked + untracked-but-not-ignored). Throws on failure (not a git repo, unreachable machine, ...). */
  fetchFileList(worktree: string): Promise<string[]>;
  /** Fetches one file's content (`fs.read`), `path` relative to `worktree`. Throws on failure (missing/escaping/binary/directory target, unreachable machine, ...). */
  fetchFileContent(worktree: string, path: string): Promise<RepoFileContent>;
}

/** One Repo Files-panel actions client per chosen machine — mirrors `UseGitDiffActions = (machineId) => GitDiffActions`. */
export type UseRepoFilesActions = (machineId: string) => RepoFilesActions;

/** One node of the nested tree `buildFileTree` (`file-tree-logic.ts`) folds a flat `git.files` listing into — a directory has `children`, a file doesn't. */
export interface FileTreeNode {
  name: string;
  /** Full worktree-relative path (e.g. `"src/features/repo-files/types.ts"`) — what `fetchFileContent`/`onSelect` actually key off of. */
  path: string;
  isDirectory: boolean;
  children?: FileTreeNode[];
}
