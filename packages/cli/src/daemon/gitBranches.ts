/**
 * `git.branches` machine RPC handler. Backs the New Session wizard's
 * existing-branch worktree picker.
 *
 * Uses `git for-each-ref refs/heads` with a tab-separated `--format` so one
 * invocation yields HEAD marker, worktree path, upstream, and last-commit
 * time. `%(worktreepath)` requires git >= 2.31; older git returns an empty
 * column (checkedOutAt stays unset, not a throw) - the actual double-checkout
 * guard is `gitWorktree.ts`.
 *
 * `refs/remotes` is only queried when `git remote` reports at least one
 * remote; the remote's `<name>/HEAD` symbolic ref is dropped (not a branch).
 */
import type { GitBranchesParams, GitBranchesResult, GitBranchInfo } from "@kvy/wire";
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
