/**
 * `git.branches` machine RPC handler (design §4.4; docs/features/
 * worktree-isolation.md Phase 2 — backs the New Session wizard's
 * existing-branch worktree picker, docs/competitive-notes-omnara.md #2/#16).
 *
 * Modeled line-for-line on `gitStatus.ts`: same injectable `git?: GitExec`
 * seam (defaulting to `gitExec.ts`'s real `runGit`), same "throw
 * `GitExecError` through, no silent empty-list fallback" contract, and the
 * same `assertWorkspaceStillValid` pre-check (known-issues.md #3) so a
 * renamed/deleted/no-longer-a-repo worktree surfaces a classified
 * `WorkspaceValidationError` instead of a raw `git` stderr string.
 *
 * Runs `git for-each-ref refs/heads` with a tab-separated `--format` so one
 * `git` invocation yields every column this handler needs — HEAD marker
 * (current branch), worktree path (branch checked out in another worktree,
 * if any — git forbids the same branch in two worktrees), upstream, and
 * last-commit time — without a second `git branch`/`git log` call per
 * branch. `%(worktreepath)` requires git >= 2.31; an older git silently
 * returns an empty column for it, so `checkedOutAt` just stays unset rather
 * than throwing — the daemon-side pre-flight guard in `gitWorktree.ts` is
 * the actual protection against double-checkout, this is best-effort UI.
 *
 * `refs/remotes` is only queried when `git remote` reports at least one
 * configured remote — skipped entirely for a local-only repo rather than
 * running a `for-each-ref` that would just come back empty. Each resulting
 * entry (e.g. `origin/main`) is marked `remote: true`; the remote's own
 * `<name>/HEAD` symbolic ref is dropped, since it isn't a branch.
 */
import type { GitBranchesParams, GitBranchesResult, GitBranchInfo } from "@falcon/wire";
import { type GitExec, runGit } from "./gitExec.js";
import { assertWorkspaceStillValid } from "./workspacePath.js";

export interface GitBranchesDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to `workspacePath.ts`'s real `assertWorkspaceStillValid`. */
  assertWorkspaceValid?: (directory: string) => Promise<void>;
}

const FORMAT = [
  "%(refname:short)",
  "%(HEAD)",
  "%(worktreepath)",
  "%(upstream:short)",
  "%(committerdate:unix)",
].join("%09");

/** Parses one tab-separated `git for-each-ref` line into a `GitBranchInfo`, or `null` for a blank line or (for a `refs/remotes` line) the remote's own `<name>/HEAD` symbolic ref. */
function parseBranchLine(line: string, remote: boolean): GitBranchInfo | null {
  if (line === "") return null;
  const [name, head, worktreePath, upstream, committerDate] = line.split("\t");
  if (!name) return null;
  if (remote && name.endsWith("/HEAD")) return null;

  const branch: GitBranchInfo = {
    name,
    isCurrent: head === "*",
  };
  if (worktreePath) branch.checkedOutAt = worktreePath;
  if (upstream) branch.upstream = upstream;
  if (committerDate) {
    const parsed = Number(committerDate);
    if (Number.isFinite(parsed)) branch.lastCommitAt = parsed;
  }
  if (remote) branch.remote = true;
  return branch;
}

/** Runs `git for-each-ref` against `refPrefix` in `worktree` and parses every line into `GitBranchInfo[]`. */
async function listRefs(
  git: GitExec,
  worktree: string,
  refPrefix: string,
  remote: boolean,
): Promise<GitBranchInfo[]> {
  const output = await git(
    ["for-each-ref", "--sort=-committerdate", `--format=${FORMAT}`, refPrefix],
    worktree,
  );

  const branches: GitBranchInfo[] = [];
  for (const line of output.split("\n")) {
    const branch = parseBranchLine(line, remote);
    if (branch) branches.push(branch);
  }
  return branches;
}

/** Runs `git for-each-ref refs/heads` (plus `refs/remotes` when a remote is configured) in `params.worktree` and parses it into a `GitBranchesResult`. Throws a `WorkspaceValidationError` if `worktree` no longer exists or isn't a git repository — checked before `git` ever runs. Throws `GitExecError` for any other `git` failure — no silent "empty branches" fallback. */
export async function getGitBranches(
  params: GitBranchesParams,
  deps: GitBranchesDeps = {},
): Promise<GitBranchesResult> {
  const assertWorkspaceValid = deps.assertWorkspaceValid ?? assertWorkspaceStillValid;
  await assertWorkspaceValid(params.worktree);
  const git = deps.git ?? runGit;

  const branches = await listRefs(git, params.worktree, "refs/heads", false);

  const hasRemote = (await git(["remote"], params.worktree)).trim() !== "";
  if (hasRemote) {
    branches.push(...(await listRefs(git, params.worktree, "refs/remotes", true)));
  }

  return { branches };
}
