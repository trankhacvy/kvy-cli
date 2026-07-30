/**
 * `git.init` machine RPC handler (docs/web-ux-improvements-plan.md Feature 1
 * — the recovery action behind the Git panel's `workspace-not-a-repo`
 * state).
 *
 * Same injectable `deps.git?`/`deps.authorizeWorktree?` shape as
 * `gitCommit.ts`/`gitPush.ts`/`gitRenameBranch.ts` — see `gitCommit.ts`'s
 * doc comment for why the mutating handlers, unlike their read-only
 * siblings, gate on the registered-workspace authorizer.
 *
 * The authorizer is load-bearing beyond the usual reason here: it resolves
 * through `isWithinRegisteredWorkspace`, which `realpath`s the directory
 * first (`workspace/registry.ts`) and returns `null` for a path that
 * doesn't exist. So a `workspace-missing` folder can never reach `git
 * init` — this handler refuses it before creating anything, and it
 * deliberately does NOT `mkdir` a missing directory (that stays
 * `fs.mkdir`'s job, behind its own explicit user approval).
 *
 * Two refusals are modeled as result STATES rather than thrown errors,
 * following `githubChecks.ts`'s precedent ("never throw for an expected
 * nothing-to-do case"):
 *   - `already-repo`: `<worktree>/.git` exists. Making this idempotent
 *     matters because a lost RPC ack is retried with the same
 *     `idempotencyKey` — and even though `machineRpc.ts` caches the prior
 *     result, a *different* key (a second device) must not error either.
 *   - `inside-existing-repo`: no local `.git`, but `git rev-parse
 *     --show-toplevel` resolves to some ancestor. `git init` here would
 *     create a NESTED repository, which silently breaks the parent's view
 *     of those files. This is a real, reachable case, not a theoretical
 *     one: `workspacePath.ts`'s `assertWorkspaceStillValid` only `stat`s
 *     `<dir>/.git`, so a plain subdirectory of a working repo already
 *     reports `workspace-not-a-repo` to the web panel.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { GitInitParams, GitInitResult } from "@falcon/wire";
import { type GitExec, runGit } from "./gitExec.js";
import { assertSafeBranchName } from "./gitWorktree.js";
import { createRegistryWorktreeAuthorizer, type WorktreeAuthorizer } from "./gitWriteGuard.js";

export interface GitInitDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to the real registered-workspace check (`gitWriteGuard.ts`). */
  authorizeWorktree?: WorktreeAuthorizer;
  /** Injectable for tests; defaults to a real `stat` of `<worktree>/.git` — the same check `workspacePath.ts` makes. */
  hasGitDir?: (worktree: string) => Promise<boolean>;
}

async function defaultHasGitDir(worktree: string): Promise<boolean> {
  return stat(path.join(worktree, ".git")).then(
    () => true,
    () => false,
  );
}

/** Resolves the toplevel of the repository `worktree` already belongs to, or `null` when it belongs to none. Never throws — a non-repo directory makes `git rev-parse` exit non-zero, which is the answer, not a failure. */
async function resolveExistingRoot(git: GitExec, worktree: string): Promise<string | null> {
  try {
    const output = (await git(["rev-parse", "--show-toplevel"], worktree)).trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
}

/** Resolves the current branch name, or `undefined` on a detached/unborn HEAD that `git` can't name. */
async function currentBranch(git: GitExec, worktree: string): Promise<string | undefined> {
  try {
    const name = (await git(["rev-parse", "--abbrev-ref", "HEAD"], worktree)).trim();
    return name === "" || name === "HEAD" ? undefined : name;
  } catch {
    // A freshly-`git init`ed repo has an unborn HEAD; `symbolic-ref` still
    // names it where `rev-parse` refuses.
    try {
      const ref = (await git(["symbolic-ref", "--short", "HEAD"], worktree)).trim();
      return ref === "" ? undefined : ref;
    } catch {
      return undefined;
    }
  }
}

/** Runs `git init` in `params.worktree`. Throws on an unauthorized worktree, an unsafe `initialBranch`, or a genuine `git init` failure; refuses (as a result `state`) an already-initialized or nested directory. */
export async function handleGitInit(
  params: GitInitParams,
  deps: GitInitDeps = {},
): Promise<GitInitResult> {
  const git = deps.git ?? runGit;
  const authorizeWorktree = deps.authorizeWorktree ?? createRegistryWorktreeAuthorizer();
  const hasGitDir = deps.hasGitDir ?? defaultHasGitDir;

  await authorizeWorktree(params.worktree);

  if (params.initialBranch !== undefined) assertSafeBranchName(params.initialBranch);

  if (await hasGitDir(params.worktree)) {
    return { state: "already-repo", branch: await currentBranch(git, params.worktree) };
  }

  const existingRoot = await resolveExistingRoot(git, params.worktree);
  if (existingRoot !== null) {
    return { state: "inside-existing-repo", existingRoot };
  }

  const args = [
    "init",
    ...(params.initialBranch ? [`--initial-branch=${params.initialBranch}`] : []),
  ];
  await git(args, params.worktree);

  return { state: "initialized", branch: await currentBranch(git, params.worktree) };
}
