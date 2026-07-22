/**
 * Git worktree/branch setup for the daemon `spawn` RPC's optional `branch`
 * field (`@falcon/wire`'s `SpawnParams.branch: {name, createWorktree, from}`,
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
 * `from` (docs/competitive-notes-omnara.md #16 "searchable base-branch
 * picker") is the optional base ref a brand-new branch forks from — passed
 * straight through to `git checkout -b`/`git worktree add -b` as the
 * trailing start-point argument (`startPointArgs`) instead of always
 * forking off whatever's currently checked out at `repoDirectory`. Ignored
 * when the branch already exists (there's no "base" to speak of once a
 * branch is real) and when omitted/blank, which preserves the pre-existing
 * behavior exactly.
 *
 * Idempotent by construction: a retried `spawn` (same `idempotencyKey`,
 * same branch) reuses an already-created worktree/branch rather than
 * failing — `git worktree add` is not itself idempotent, so this checks
 * first.
 *
 * **Checked-out-elsewhere guard** (docs/features/worktree-isolation.md
 * Phase 3): git forbids the same branch from being checked out in two
 * worktrees at once — attempting it fails with a raw `fatal: '<branch>' is
 * already used by worktree at '<path>'` from the underlying `git checkout`/
 * `git worktree add` call. `assertNotCheckedOutElsewhere` pre-flights this
 * (via `git for-each-ref --format=%(worktreepath)`) and throws a typed,
 * readable `GitWorktreeError` instead, on both the in-place-checkout path
 * (`createWorktree: false`) and the worktree-creation path. A branch already
 * checked out at the exact target directory is fine (the idempotent-reuse
 * case above already returns early for a worktree that exists on disk, but
 * this also covers "worktree dir doesn't exist locally yet — race with
 * another daemon/process" the same way).
 *
 * **`.git/info/exclude` entry:** after creating a worktree, this
 * idempotently appends a `.worktrees/` line to the parent repo's
 * `.git/info/exclude` so the container directory doesn't show up as
 * untracked clutter in the repo's own `git status`. Best-effort only — see
 * `ensureWorktreesExcluded`'s own doc comment for why a failure here is
 * swallowed rather than failing the spawn. `git >= 2.31` is required for
 * `%(worktreepath)` to actually populate; an older git silently returns an
 * empty column, degrading the checked-out-elsewhere guard to a no-op for
 * that one atom (not a crash) — there is no minimum-git-version check
 * anywhere in the daemon today.
 *
 * Every git invocation is a plain `execFile` call, hand-wrapped (not
 * `util.promisify`) for the same mockability reason as `processScan.ts`'s
 * `runPs` — no dependence on `execFile`'s `promisify.custom` symbol.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

/**
 * Returns the absolute path of the worktree `branchName` is currently
 * checked out in, or `undefined` if it isn't checked out in any worktree
 * (including: the branch doesn't exist yet, git predates 2.31's
 * `%(worktreepath)` atom and silently returns an empty column, or the
 * branch is simply free). Callers only call this once `branchExists` has
 * already confirmed the branch is real — `for-each-ref` on a nonexistent
 * ref just yields no output either way, so this alone can't distinguish
 * "doesn't exist" from "not checked out anywhere."
 */
async function findCheckedOutWorktree(
  git: GitExec,
  cwd: string,
  branchName: string,
): Promise<string | undefined> {
  const output = await git(
    ["for-each-ref", `--format=%(worktreepath)`, `refs/heads/${branchName}`],
    cwd,
  );
  const trimmed = output.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Throws a typed, human-readable `GitWorktreeError` — instead of letting
 * git's own raw stderr ("fatal: '<branch>' is already used by worktree at
 * '<path>'") surface — when `branchName` is already checked out in some
 * worktree other than `targetDir` (git forbids the same branch in two
 * worktrees at once, whether via `checkout` or `worktree add`;
 * docs/features/worktree-isolation.md Phase 3). A no-op when the branch is
 * either unchecked-out or already checked out at `targetDir` itself (the
 * idempotent-reuse case).
 */
async function assertNotCheckedOutElsewhere(
  git: GitExec,
  repoDirectory: string,
  branchName: string,
  targetDir: string,
): Promise<void> {
  const checkedOutAt = await findCheckedOutWorktree(git, repoDirectory, branchName);
  if (checkedOutAt !== undefined && checkedOutAt !== targetDir) {
    throw new GitWorktreeError(
      `branch "${branchName}" is already checked out at ${checkedOutAt} — a branch can only be checked out in one worktree`,
    );
  }
}

/**
 * Idempotently ensures the parent repo's `.git/info/exclude` ignores the
 * `.worktrees/` container this module creates worktrees under, so a
 * worktree-mode spawn doesn't show up as untracked clutter in the repo's
 * own `git status` (docs/features/worktree-isolation.md Phase 3). Purely a
 * git-status hygiene nicety, not the actual protection against anything —
 * best-effort: `repoDirectory` not being a plain repo (e.g. itself a
 * worktree, where `.git` is a file, not a directory) or any read/write
 * failure is swallowed rather than failing the spawn. This module has no
 * logger to report the swallow through (unlike `gitDiff.ts`'s injected
 * `Logger`), so there is nothing else to do with a failure here besides
 * ignore it.
 */
async function ensureWorktreesExcluded(repoDirectory: string): Promise<void> {
  const excludePath = path.join(repoDirectory, ".git", "info", "exclude");
  try {
    const gitDirStat = await stat(path.join(repoDirectory, ".git"));
    if (!gitDirStat.isDirectory()) return;

    let existing = "";
    try {
      existing = await readFile(excludePath, "utf8");
    } catch {
      // Missing `info/exclude` is fine — every line in it, including the
      // one below, is written fresh.
    }
    const lines = existing.split("\n");
    if (lines.some((line) => line.trim() === ".worktrees/")) return;

    const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
    await writeFile(excludePath, `${existing}${separator}.worktrees/\n`, "utf8");
  } catch {
    // Best-effort: an exclude-write failure must not fail the spawn.
  }
}

/**
 * Trailing `git checkout -b`/`git worktree add -b` argv for a brand-new
 * branch's start point (docs/competitive-notes-omnara.md #16 "searchable
 * base-branch picker") — `[from]` when a base ref was picked, or `[]` to
 * fall back to git's own default (branch from whatever's currently checked
 * out), preserving the pre-existing behavior when the wizard's base-branch
 * picker is left at its default. Only meaningful on the branch-doesn't-exist
 * path — an already-existing branch has no "base" to speak of, so callers
 * never reach here with `exists === true`.
 */
function startPointArgs(from: string | undefined): string[] {
  return from === undefined || from.trim() === "" ? [] : [from];
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
    if (exists) {
      await assertNotCheckedOutElsewhere(git, repoDirectory, branch.name, repoDirectory);
    }
    await git(
      exists
        ? ["checkout", branch.name]
        : ["checkout", "-b", branch.name, ...startPointArgs(branch.from)],
      repoDirectory,
    );
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
  if (exists) {
    await assertNotCheckedOutElsewhere(git, repoDirectory, branch.name, worktreeDir);
  }
  await git(
    exists
      ? ["worktree", "add", worktreeDir, branch.name]
      : ["worktree", "add", worktreeDir, "-b", branch.name, ...startPointArgs(branch.from)],
    repoDirectory,
  );
  await ensureWorktreesExcluded(repoDirectory);
  return { directory: worktreeDir };
}
