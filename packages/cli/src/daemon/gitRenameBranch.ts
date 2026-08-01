/**
 * `git.renameBranch` machine RPC handler (design §4.4, docs/features/
 * git-write-actions.md Phase 2).
 *
 * Same injectable `deps.git?`/`deps.authorizeWorktree?` shape as
 * `gitCommit.ts`/`gitPush.ts`. Reuses `gitWorktree.ts`'s
 * `assertSafeBranchName` verbatim — same argv-injection hazard as that
 * module's own `branch.name`, guarding both `params.to` and (when given)
 * `params.from`. Deliberately does NOT reuse that module's
 * `assertNotCheckedOutElsewhere`: git allows renaming a branch that's
 * checked out elsewhere (unlike creating a *second* worktree for the same
 * branch), and renaming the *current* branch — the primary use case here —
 * requires it to stay checked out in place.
 *
 * Local-only (`git branch -m`): the remote branch, if any, keeps its old
 * name until the next push. `hadUpstream` tells the caller to surface that
 * as a warning.
 *
 * Concurrency: no resource-keyed guard here (unlike `adopt.take`'s
 * `withProviderSessionGuard`) — two devices renaming the same branch at
 * once rely on git's own ref-lock serialization; whichever loses gets a
 * `GitExecError` with git's own stderr.
 */
import type { GitRenameBranchParams, GitRenameBranchResult } from "@kvy/wire";
import { type GitExec, runGit } from "./gitExec.js";
import { assertSafeBranchName } from "./gitWorktree.js";
import { createRegistryWorktreeAuthorizer, type WorktreeAuthorizer } from "./gitWriteGuard.js";

export interface GitRenameBranchDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to the real registered-workspace check (`gitWriteGuard.ts`). */
  authorizeWorktree?: WorktreeAuthorizer;
}

/** Returns whether `refs/heads/<branchName>` has a configured upstream. */
async function hasUpstream(git: GitExec, worktree: string, branchName: string): Promise<boolean> {
  const output = await git(
    ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branchName}`],
    worktree,
  );
  return output.trim() !== "";
}

/** Runs `git branch -m [<from>] <to>` in `params.worktree`. Throws on any `git` failure, an unauthorized worktree, or an unsafe `to`/`from` branch name. */
export async function handleGitRenameBranch(
  params: GitRenameBranchParams,
  deps: GitRenameBranchDeps = {},
): Promise<GitRenameBranchResult> {
  const git = deps.git ?? runGit;
  const authorizeWorktree = deps.authorizeWorktree ?? createRegistryWorktreeAuthorizer();

  await authorizeWorktree(params.worktree);

  assertSafeBranchName(params.to);
  if (params.from !== undefined) assertSafeBranchName(params.from);

  const sourceBranch =
    params.from ?? (await git(["rev-parse", "--abbrev-ref", "HEAD"], params.worktree)).trim();
  const hadUpstream = await hasUpstream(git, params.worktree, sourceBranch);

  await git(
    params.from ? ["branch", "-m", params.from, params.to] : ["branch", "-m", params.to],
    params.worktree,
  );

  return { ok: true, branch: params.to, hadUpstream };
}
