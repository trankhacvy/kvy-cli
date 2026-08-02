/**
 * Shared base-ref resolution for `gitStatus.ts`/`gitDiff.ts`. Precedence:
 *
 *  1. Explicit `baseRef` param (one-off override from the web panel).
 *  2. Workspace configured base ref (`workspaceConfig.ts`).
 *  3. Local `main` or `master` branch - deliberately NOT `origin/HEAD`: a
 *     repo with no remote still has a valid local default, no network needed.
 *  4. Neither exists: `undefined` - caller falls back to its own last resort.
 */

import { readWorkspaceGitConfig } from "../workspaceConfig.js";
import { type GitExec, runGit } from "./gitExec.js";

/** Git's well-known empty-tree object — always present in every repository, even one with zero commits. Diffing against it makes every tracked/staged path show up as newly added, which is exactly right for a repo that has no commits yet (`HEAD` doesn't resolve to anything there — see `resolveDiffBaseline`). */
export const GIT_EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const DEFAULT_BRANCH_CANDIDATES = ["main", "master"] as const;

export interface ResolveBaseRefDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to `workspaceConfig.ts`'s real `~/.kvy/settings.json`-backed lookup. */
  resolveConfiguredBaseRef?: (worktree: string) => Promise<string | undefined>;
}

async function defaultResolveConfiguredBaseRef(worktree: string): Promise<string | undefined> {
  const config = await readWorkspaceGitConfig(worktree);
  return config?.baseRef;
}

async function localBranchExists(git: GitExec, worktree: string, branch: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], worktree);
    return true;
  } catch {
    return false;
  }
}

/** Whether `worktree` has at least one commit — `false` for a freshly `git init`ed repo (an "unborn" `HEAD`, before the first commit). */
export async function hasAnyCommits(worktree: string, git: GitExec = runGit): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", "HEAD"], worktree);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the ref to compare `worktree` against, per the precedence above. Returns `undefined` if nothing applies — the caller decides its own final fallback (`gitDiff.ts`/`gitStatus.ts` both use `resolveDiffBaseline` for that). Never throws: an unresolvable candidate just isn't offered, same as a missing config. */
export async function resolveEffectiveBaseRef(
  worktree: string,
  explicitBaseRef: string | undefined,
  deps: ResolveBaseRefDeps = {},
): Promise<string | undefined> {
  if (explicitBaseRef !== undefined) return explicitBaseRef;

  const resolveConfigured = deps.resolveConfiguredBaseRef ?? defaultResolveConfiguredBaseRef;
  const configured = await resolveConfigured(worktree);
  if (configured !== undefined) return configured;

  const git = deps.git ?? runGit;
  for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
    if (await localBranchExists(git, worktree, candidate)) return candidate;
  }

  return undefined;
}

/**
 * The final ref to actually pass to `git diff`/`git diff --numstat` once
 * `resolveEffectiveBaseRef` comes up empty (no explicit/configured ref, and
 * neither `main` nor `master` exists locally — e.g. a solo `feature` branch
 * repo). Falls back to `HEAD` (today's long-standing behavior: just the
 * uncommitted working-tree changes) when the repo has commits, or the git
 * empty-tree hash when it doesn't — fixes the `fatal: bad revision 'HEAD'`
 * crash on a brand-new repo with no commits yet.
 */
export async function resolveDiffBaseline(
  worktree: string,
  git: GitExec = runGit,
): Promise<string> {
  return (await hasAnyCommits(worktree, git)) ? "HEAD" : GIT_EMPTY_TREE_HASH;
}
