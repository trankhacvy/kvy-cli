/**
 * `worktree.remove` machine RPC handler (Phase C, new-session-from-web
 * redesign — see `@kvy/wire`'s `WorktreeRemoveParamsSchema` doc comment
 * for the full "why"). A manual "clean up this session's worktree" action —
 * every session spawned via the workspace-row `+` flow now creates a fresh
 * `.worktrees/<branch>` directory (`gitWorktree.ts`'s `ensureBranchWorkspace`)
 * with nothing that ever cleans it up automatically.
 *
 * **Safety.** Two independent gates, both required, before touching
 * anything on disk:
 *  1. `isWithinRegisteredWorkspace` (`workspace/registry.ts`) — same
 *     registered-workspace authorization the mutating git RPCs
 *     (`gitCommit.ts`/`gitPush.ts`) already require, so an authenticated
 *     device can't point this at an arbitrary machine directory.
 *  2. `assertLooksLikeWorktreeDir` below — `worktree` must contain a
 *     `.worktrees` path segment. This is deliberately independent of which
 *     registry entry matched: a worktree-mode session's own cwd gets
 *     registered as ITS OWN workspace entry (`commands/start.ts`'s
 *     registration call registers whatever `process.cwd()` is, with no
 *     ancestor resolution — `workspace/registry.ts`'s `registerWorkspace`
 *     doc comment), so `isWithinRegisteredWorkspace(worktree)` can match
 *     the worktree's OWN exact entry rather than some ancestor `.worktrees/`
 *     relationship. Without this second, structural check, gate 1 alone
 *     would happily authorize `git worktree remove` (and worse, `git branch
 *     -D`) against a plain repo-root workspace too — this is the check that
 *     actually prevents that.
 *
 * **Uncommitted/untracked changes.** `git worktree remove` refuses outright
 * (leaving the worktree untouched) when the worktree has modified or
 * untracked files — verified against the real command, not assumed; see
 * this module's own tests. Rather than silently discarding that work with
 * `--force` or silently failing with a bare git error, the first attempt is
 * always plain (no `--force`); a refusal for exactly that reason resolves
 * as `{removed:false, requiresForce:true}` so the caller can confirm with
 * the user and retry with `params.force`. Any other failure (not a linked
 * worktree, git error, ...) throws through as a `GitExecError` instead —
 * genuinely unexpected, not a "confirm and retry" case.
 *
 * **Already-removed.** A `worktree` that simply no longer exists on disk
 * (the user clicked "Remove" twice, or removed it by hand in a terminal) is
 * a safe no-op success (`{removed:true}`) rather than a thrown git error —
 * detected with a plain `stat` before git is ever invoked, not by
 * pattern-matching git's own (version/locale-dependent) error text. Same
 * "idempotent no-op for an already-gone entry" precedent
 * `workspace/registry.ts`'s `unregisterWorkspace` already sets.
 *
 * **Resolving the real repo root.** `worktree` is a linked worktree's own
 * directory — running `git worktree remove <worktree>` needs to be invoked
 * against the repo's actual administrative git dir, which
 * `resolveMainWorktreeRoot` discovers via `git rev-parse --git-common-dir`
 * run IN the worktree itself (a read-only call, safe regardless of what
 * happens next) rather than assuming a fixed `<root>/.worktrees/<branch>`
 * shape — a branch name containing `/` (this codebase's own
 * `wf/yyyyMMdd-xxxx` convention) nests `.worktrees/wf/yyyyMMdd-xxxx`, so a
 * naive `path.dirname(path.dirname(worktree))` would be wrong for anything
 * but a single-segment branch name.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { WorktreeRemoveParams, WorktreeRemoveResult } from "@kvy/wire";
import { isWithinRegisteredWorkspace, type RegistryOptions } from "../workspace/registry.js";
import { type GitExec, GitExecError, runGit } from "./gitExec.js";

const REQUIRES_FORCE_RE = /contains modified or untracked files|use --force/i;

/** Throws a `GitExecError` unless `worktree`'s own path contains a `.worktrees` segment — see this module's doc comment for why this check is independent of (and in addition to) the registry authorization. */
function assertLooksLikeWorktreeDir(worktree: string): void {
  const segments = path.resolve(worktree).split(path.sep);
  if (!segments.includes(".worktrees")) {
    throw new GitExecError(
      `refusing to remove "${worktree}": it doesn't look like a Kvy-managed .worktrees/ directory`,
    );
  }
}

/** The real git repo root for `worktree` (a linked worktree's own directory) — `path.dirname` of `git rev-parse --git-common-dir`'s absolute output, discovered by running git IN `worktree` itself. A pure, read-only lookup, safe to run before any authorization/safety check has even completed. */
async function resolveMainWorktreeRoot(git: GitExec, worktree: string): Promise<string> {
  const gitCommonDir = (
    await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktree)
  ).trim();
  return path.dirname(gitCommonDir);
}

export interface WorktreeRemoveDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to the real registry check (`workspace/registry.ts`). */
  authorize?: (worktree: string) => Promise<unknown>;
  /** Injectable for tests; defaults to `node:fs/promises`' real `stat`. Backs the already-removed short-circuit below. */
  stat?: typeof stat;
  registryOptions?: RegistryOptions;
}

export async function removeWorktree(
  params: WorktreeRemoveParams,
  deps: WorktreeRemoveDeps = {},
): Promise<WorktreeRemoveResult> {
  const git = deps.git ?? runGit;
  const authorize =
    deps.authorize ??
    ((worktree: string) => isWithinRegisteredWorkspace(worktree, deps.registryOptions));
  const statFn = deps.stat ?? stat;

  const entry = await authorize(params.worktree);
  if (!entry) {
    throw new GitExecError(`worktree is not inside a registered workspace: ${params.worktree}`);
  }
  assertLooksLikeWorktreeDir(params.worktree);

  // Already-removed edge case, handled honestly rather than left to git's
  // own (version/locale-dependent) error text: a directory that's simply
  // gone is a safe no-op success, same "idempotent no-op" precedent
  // `workspace/registry.ts`'s own `unregisterWorkspace` already sets for an
  // already-gone/never-registered entry.
  const exists = await statFn(params.worktree).then(
    () => true,
    () => false,
  );
  if (!exists) {
    return { removed: true };
  }

  const mainRoot = await resolveMainWorktreeRoot(git, params.worktree);

  try {
    await git(
      params.force
        ? ["worktree", "remove", "--force", params.worktree]
        : ["worktree", "remove", params.worktree],
      mainRoot,
    );
  } catch (error) {
    if (error instanceof GitExecError && !params.force && REQUIRES_FORCE_RE.test(error.message)) {
      return { removed: false, requiresForce: true };
    }
    throw error;
  }

  if (!params.deleteBranch) {
    return { removed: true };
  }

  // The branch name is exactly the worktree's path relative to
  // `<mainRoot>/.worktrees` (`gitWorktree.ts`'s own `path.join(repoDirectory,
  // ".worktrees", branch.name)` construction) — reversible without a
  // separate `git worktree list --porcelain` parse.
  const branchName = path
    .relative(path.join(mainRoot, ".worktrees"), path.resolve(params.worktree))
    .split(path.sep)
    .join("/");

  try {
    await git(["branch", "-D", branchName], mainRoot);
    return { removed: true, branchDeleted: true };
  } catch {
    // The safe part (removing the worktree directory) already succeeded —
    // a branch-delete failure (e.g. it's checked out elsewhere, or was
    // already deleted) must not be reported as an overall failure of this
    // call. Honest, not silent: `branchDeleted: false` tells the caller
    // exactly what did and didn't happen.
    return { removed: true, branchDeleted: false };
  }
}
