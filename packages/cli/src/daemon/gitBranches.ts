/**
 * `git.branches` machine RPC handler (design §4.4; docs/features/
 * worktree-isolation.md Phase 2 — backs the New Session wizard's
 * existing-branch worktree picker, docs/competitive-notes-omnara.md #2/#16).
 *
 * Modeled line-for-line on `gitStatus.ts`: same injectable `git?: GitExec`
 * seam (defaulting to `gitExec.ts`'s real `runGit`), same "throw
 * `GitExecError` through, no silent empty-list fallback" contract.
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
 */
import type { GitBranchesParams, GitBranchesResult, GitBranchInfo } from "@falcon/wire";
import { type GitExec, runGit } from "./gitExec.js";

export interface GitBranchesDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
}

const FORMAT = [
  "%(refname:short)",
  "%(HEAD)",
  "%(worktreepath)",
  "%(upstream:short)",
  "%(committerdate:unix)",
].join("%09");

/** Parses one tab-separated `git for-each-ref` line into a `GitBranchInfo`, or `null` for a blank line. */
function parseBranchLine(line: string): GitBranchInfo | null {
  if (line === "") return null;
  const [name, head, worktreePath, upstream, committerDate] = line.split("\t");
  if (!name) return null;

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
  return branch;
}

/** Runs `git for-each-ref refs/heads` in `params.worktree` and parses it into a `GitBranchesResult`. Throws `GitExecError` if `worktree` isn't a git repository (or any other `git` failure) — no silent "empty branches" fallback. */
export async function getGitBranches(
  params: GitBranchesParams,
  deps: GitBranchesDeps = {},
): Promise<GitBranchesResult> {
  const git = deps.git ?? runGit;
  const output = await git(
    ["for-each-ref", "--sort=-committerdate", `--format=${FORMAT}`, "refs/heads"],
    params.worktree,
  );

  const branches: GitBranchInfo[] = [];
  for (const line of output.split("\n")) {
    const branch = parseBranchLine(line);
    if (branch) branches.push(branch);
  }

  return { branches };
}
