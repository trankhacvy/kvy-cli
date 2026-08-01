/**
 * `git.push` machine RPC handler (design §4.4, docs/features/
 * git-write-actions.md Phase 2).
 *
 * Same injectable `deps.git?`/`deps.authorizeWorktree?` shape as
 * `gitCommit.ts` — see that module's doc comment.
 *
 * `params.force: true` maps ONLY to `--force-with-lease`, never the raw
 * `--force` flag — the raw flag is deliberately unreachable from this
 * handler's argv construction (a data-loss containment decision; see
 * `@kvy/wire`'s `GitPushParamsSchema` doc comment). A force-push-with-
 * lease can still fail (safely, refusing to push) when the local
 * remote-tracking ref is stale, which is the whole point of `--lease`
 * over raw `--force`.
 *
 * No credential management: push auth is whatever the machine's ambient
 * git credential helper / SSH agent already provides — Kvy manages
 * none of it. A machine with no configured credentials just gets git's own
 * error surfaced through `GitExecError`.
 */
import type { GitPushParams, GitPushResult } from "@kvy/wire";
import { type GitExec, GitExecError, runGit } from "./gitExec.js";
import { createRegistryWorktreeAuthorizer, type WorktreeAuthorizer } from "./gitWriteGuard.js";

export interface GitPushDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to the real registered-workspace check (`gitWriteGuard.ts`). */
  authorizeWorktree?: WorktreeAuthorizer;
}

/**
 * Rejects a remote/branch name that could be parsed as a `git push` option
 * (a leading `-`) or that escapes a ref-name segment (a `..` component) —
 * same hazard, and same shape, as `gitWorktree.ts`'s `assertSafeBranchName`,
 * kept as its own local copy so this handler's errors stay a `GitExecError`
 * (matching every other error this handler can throw) rather than mixing in
 * that module's `GitWorktreeError`.
 */
function assertSafeRefName(kind: "branch" | "remote", value: string): void {
  if (
    value.trim() === "" ||
    value.startsWith("-") ||
    value.split("/").some((segment) => segment === "..")
  ) {
    throw new GitExecError(`unsafe ${kind} name: ${value}`);
  }
}

/** Runs `git push` in `params.worktree`, resolving the current branch when `params.branch` is omitted (rejecting a detached HEAD). Throws `GitExecError` on any `git` failure, an unauthorized worktree, an unsafe branch/remote, or a detached HEAD with no explicit branch. */
export async function handleGitPush(
  params: GitPushParams,
  deps: GitPushDeps = {},
): Promise<GitPushResult> {
  const git = deps.git ?? runGit;
  const authorizeWorktree = deps.authorizeWorktree ?? createRegistryWorktreeAuthorizer();

  await authorizeWorktree(params.worktree);

  let branch = params.branch;
  if (branch === undefined) {
    const current = (await git(["rev-parse", "--abbrev-ref", "HEAD"], params.worktree)).trim();
    if (current === "HEAD") {
      throw new GitExecError("cannot push: HEAD is detached, no branch to push");
    }
    branch = current;
  }
  assertSafeRefName("branch", branch);

  const remote = params.remote ?? "origin";
  assertSafeRefName("remote", remote);

  const args = [
    "push",
    ...(params.force ? ["--force-with-lease"] : []),
    ...(params.setUpstream ? ["-u"] : []),
    remote,
    branch,
  ];
  await git(args, params.worktree);

  return { ok: true, remote, branch, forced: params.force === true };
}
