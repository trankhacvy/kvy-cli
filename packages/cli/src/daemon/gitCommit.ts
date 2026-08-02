/**
 * git-write-actions.md Phase 2 — the first *mutating* git RPC).
 *
 * Modeled on `gitBranches.ts`/`gitStatus.ts`'s injectable `git?: GitExec`
 * seam (defaulting to `gitExec.ts`'s real `runGit`), plus a second
 * injectable `authorizeWorktree?: WorktreeAuthorizer` seam (defaulting to
 * `gitWriteGuard.ts`'s real registered-workspace check — see that module's
 * doc comment for why mutating RPCs, unlike their read-only siblings, gate
 * on it).
 *
 * `stageAll: true` runs `git add -A` first, so the commit includes exactly
 * what the panel's changed-files list shows (tracked *and* untracked);
 * omitted/`false` runs `git commit -a` instead, tracked changes only. The
 * commit message is always passed as its own `execFile` argv element (no
 * shell involved — see `gitExec.ts`), so there's no quoting hazard from
 * message content.
 *
 * "Nothing to commit" is detected by matching git's own stderr (surfaced
 * through `GitExecError.message`) against a loose, English-locale pattern —
 * git's exact wording varies by version/locale, so this is deliberately
 * permissive: a mismatch just degrades to the `GitExecError` being thrown
 * through and shown to the user (annoying, not dangerous), never a
 * fabricated `committed: true`.
 */
import type { GitCommitParams, GitCommitResult } from "@kvy/wire";
import { type GitExec, GitExecError, runGit } from "./gitExec.js";
import { createRegistryWorktreeAuthorizer, type WorktreeAuthorizer } from "./gitWriteGuard.js";

export interface GitCommitDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to the real registered-workspace check (`gitWriteGuard.ts`). */
  authorizeWorktree?: WorktreeAuthorizer;
}

const NOTHING_TO_COMMIT_RE = /nothing (added )?to commit|working tree clean/i;

/** Runs `git commit` (optionally preceded by `git add -A`) in `params.worktree`. Throws `GitExecError` on any `git` failure or an unauthorized worktree — except a clean working tree, which resolves as `{committed:false, nothingToCommit:true}` rather than throwing. */
export async function handleGitCommit(
  params: GitCommitParams,
  deps: GitCommitDeps = {},
): Promise<GitCommitResult> {
  const git = deps.git ?? runGit;
  const authorizeWorktree = deps.authorizeWorktree ?? createRegistryWorktreeAuthorizer();

  await authorizeWorktree(params.worktree);

  if (params.stageAll) {
    await git(["add", "-A"], params.worktree);
  }

  try {
    await git(
      params.stageAll ? ["commit", "-m", params.message] : ["commit", "-am", params.message],
      params.worktree,
    );
  } catch (error) {
    if (error instanceof GitExecError && NOTHING_TO_COMMIT_RE.test(error.message)) {
      return { committed: false, nothingToCommit: true };
    }
    throw error;
  }

  const commitSha = (await git(["rev-parse", "HEAD"], params.worktree)).trim();
  return { committed: true, commitSha };
}
