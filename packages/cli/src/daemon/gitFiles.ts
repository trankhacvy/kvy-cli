/**
 * `git.files` machine RPC handler (design §4.4's `git.*` family; docs/
 * competitive-notes-omnara.md #5 "Full repo file browser" — the "Repo
 * Files" sidebar tab's flat file listing, joining `git.status`/`git.diff`/
 * `git.branches` above). Backs the web repo file tree.
 *
 * Modeled line-for-line on `gitBranches.ts`/`gitStatus.ts`: same injectable
 * `git?: GitExec` seam (defaulting to `gitExec.ts`'s real `runGit`), same
 * "throw `GitExecError` through, no silent empty-list fallback" contract.
 *
 * `git ls-files --cached --others --exclude-standard` lists every tracked
 * file plus every untracked file `.gitignore` doesn't exclude — exactly the
 * set a repo file browser wants to show (skip `node_modules`/build output/
 * anything else the repo itself says to ignore), without this handler
 * needing its own ignore-file parser.
 */
import type { GitFilesParams, GitFilesResult } from "@falcon/wire";
import { type GitExec, runGit } from "./gitExec.js";

export interface GitFilesDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
}

/** Runs `git ls-files --cached --others --exclude-standard` in `params.worktree` and returns the sorted, non-empty lines as a `GitFilesResult`. Throws `GitExecError` if `worktree` isn't a git repository (or any other `git` failure) — no silent "empty file list" fallback. */
export async function getGitFiles(
  params: GitFilesParams,
  deps: GitFilesDeps = {},
): Promise<GitFilesResult> {
  const git = deps.git ?? runGit;
  const output = await git(
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    params.worktree,
  );

  const files = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();

  return { files };
}
