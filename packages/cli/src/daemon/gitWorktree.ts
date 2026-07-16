/**
 * Git worktree/branch setup for the daemon `spawn` RPC's optional `branch`
 * field (`@falcon/wire`'s `SpawnParams.branch: {name, createWorktree}`,
 * falcon-prd.md FR-1.2 "`falcon -b <branch>`" / FR-4.3, plan.md §16 "3.1
 * Remote spawn" — "Branch/worktree option (-b): `git worktree add` via
 * daemon"). Called from `spawnEngine.ts` after workspace-path validation,
 * before the provider process is launched.
 *
 * `createWorktree: true` creates a fresh worktree at
 * `<repoDirectory>/.worktrees/<branch>` — the same sibling-directory
 * convention this monorepo's own Falcon dev loop uses for isolated task
 * branches — and the session launches there instead of in `repoDirectory`
 * itself, so a remote spawn on a new branch never touches the caller's
 * existing checkout. `createWorktree: false` just checks out (creating if
 * needed) the branch in `repoDirectory` directly, no new worktree.
 *
 * Idempotent by construction: a retried `spawn` (same `idempotencyKey`,
 * same branch) reuses an already-created worktree/branch rather than
 * failing — `git worktree add` is not itself idempotent, so this checks
 * first.
 *
 * Every git invocation is a plain `execFile` call, hand-wrapped (not
 * `util.promisify`) for the same mockability reason as `processScan.ts`'s
 * `runPs` — no dependence on `execFile`'s `promisify.custom` symbol.
 */
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SpawnParams } from "@falcon/wire";

export class GitWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

/** Runs `git <args>` in `cwd`, resolving stdout or rejecting with a `GitWorktreeError` carrying git's own stderr. Injectable for tests. */
export type GitExec = (args: string[], cwd: string) => Promise<string>;

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new GitWorktreeError(stderr.toString().trim() || error.message));
        return;
      }
      resolve(stdout.toString());
    });
  });
}

export interface GitWorktreeDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
}

async function branchExists(git: GitExec, cwd: string, branchName: string): Promise<boolean> {
  try {
    await git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Rejects a branch name that could be used to escape `.worktrees/` via `path.join`. */
function assertSafeBranchName(branchName: string): void {
  if (branchName.trim() === "" || branchName.split("/").some((segment) => segment === "..")) {
    throw new GitWorktreeError(`unsafe branch name: ${branchName}`);
  }
}

export interface EnsureBranchWorkspaceParams {
  /** The already-validated, real (symlink-resolved) workspace directory — `workspacePath.ts`'s output. */
  repoDirectory: string;
  branch: NonNullable<SpawnParams["branch"]>;
}

/**
 * Resolves `params.branch` into the directory the session should actually
 * launch in: either `repoDirectory` itself (branch checked out in place) or
 * a new `.worktrees/<branch>` directory beneath it.
 */
export async function ensureBranchWorkspace(
  params: EnsureBranchWorkspaceParams,
  deps: GitWorktreeDeps = {},
): Promise<{ directory: string }> {
  const git = deps.git ?? ((args: string[], cwd: string) => runGit(args, cwd));
  const { repoDirectory, branch } = params;
  assertSafeBranchName(branch.name);

  if (!branch.createWorktree) {
    const exists = await branchExists(git, repoDirectory, branch.name);
    await git(exists ? ["checkout", branch.name] : ["checkout", "-b", branch.name], repoDirectory);
    return { directory: repoDirectory };
  }

  const worktreeDir = path.join(repoDirectory, ".worktrees", branch.name);

  const alreadyThere = await stat(worktreeDir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (alreadyThere) {
    return { directory: worktreeDir };
  }

  await mkdir(path.dirname(worktreeDir), { recursive: true });
  const exists = await branchExists(git, repoDirectory, branch.name);
  await git(
    exists
      ? ["worktree", "add", worktreeDir, branch.name]
      : ["worktree", "add", worktreeDir, "-b", branch.name],
    repoDirectory,
  );
  return { directory: worktreeDir };
}
