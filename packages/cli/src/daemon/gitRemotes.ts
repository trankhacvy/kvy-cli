/**
 * `git.remotes` machine RPC handler — lists configured git remotes for the
 * workspace settings Git tab's remote-name autofill. Modeled line-for-line
 * on `gitBranches.ts`: same injectable `git?: GitExec` seam, same "throw
 * `GitExecError` through, no silent empty-list fallback" contract, and the
 * same `assertWorkspaceStillValid` pre-check so a
 * renamed/deleted/no-longer-a-repo worktree surfaces a classified
 * `WorkspaceValidationError` instead of a raw `git` stderr string.
 *
 * Runs `git remote -v` and keeps only `(fetch)` rows — `-v` lists each
 * remote twice (fetch + push); a remote with distinct fetch/push URLs still
 * only needs its one canonical (fetch) URL here.
 */
import type { GitRemoteInfo, GitRemotesParams, GitRemotesResult } from "@kvy/wire";
import { type GitExec, runGit } from "./gitExec.js";
import { assertWorkspaceStillValid } from "./workspacePath.js";

export interface GitRemotesDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to `workspacePath.ts`'s real `assertWorkspaceStillValid`. */
  assertWorkspaceValid?: (directory: string) => Promise<void>;
}

/** Parses one `git remote -v` line (`"<name>\t<url> (fetch|push)"`) into a `GitRemoteInfo`, or `null` for anything but a `(fetch)` row. */
function parseRemoteLine(line: string): GitRemoteInfo | null {
  const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
  if (!match) return null;
  const [, name, url] = match;
  if (!name || !url) return null;
  return { name, url };
}

/** Runs `git remote -v` in `params.worktree` and parses it into a `GitRemotesResult`. Throws a `WorkspaceValidationError` if `worktree` no longer exists or isn't a git repository — checked before `git` ever runs. Throws `GitExecError` for any other `git` failure — no silent "empty remotes" fallback. */
export async function getGitRemotes(
  params: GitRemotesParams,
  deps: GitRemotesDeps = {},
): Promise<GitRemotesResult> {
  const assertWorkspaceValid = deps.assertWorkspaceValid ?? assertWorkspaceStillValid;
  await assertWorkspaceValid(params.worktree);
  const git = deps.git ?? runGit;
  const output = await git(["remote", "-v"], params.worktree);

  const remotes: GitRemoteInfo[] = [];
  for (const line of output.split("\n")) {
    const remote = parseRemoteLine(line);
    if (remote) remotes.push(remote);
  }

  return { remotes };
}
