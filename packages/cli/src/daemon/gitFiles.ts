/**
 * `git.files` machine RPC handler (design §4.4's `git.*` family; docs/
 * competitive-notes-omnara.md #5 "Full repo file browser" — the "Repo
 * Files" sidebar tab's flat file listing, joining `git.status`/`git.diff`/
 * `git.branches` above). Backs the web repo file tree.
 *
 * `git ls-files --cached --others --exclude-standard` lists every tracked
 * file plus every untracked file `.gitignore` doesn't exclude — exactly the
 * set a repo file browser wants to show (skip `node_modules`/build output/
 * anything else the repo itself says to ignore), without this handler
 * needing its own ignore-file parser. `falcon claude` also runs in folders
 * that were never a git repo at all — for those, `ls-files` has nothing to
 * read, so this falls back to a plain recursive directory walk (skipping a
 * small hardcoded list of directories no one wants in a file browser) rather
 * than leaving the tab unusable outside a repo. Any OTHER `git` failure
 * (permissions, a corrupt repo, etc.) still throws `GitExecError` through —
 * only "not a git repository" triggers the fallback.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { GitFilesParams, GitFilesResult } from "@falcon/wire";
import { GitExecError, type GitExec, runGit } from "./gitExec.js";

const NOT_A_GIT_REPOSITORY_RE = /not a git repository/i;

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
]);

export interface GitFilesDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to a real recursive `fs.readdir` walk of `worktree`. */
  listPlainFiles?: (worktree: string) => Promise<string[]>;
}

async function listPlainFilesDefault(worktree: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string, relativePrefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        await walk(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  await walk(worktree, "");
  return files;
}

/** Runs `git ls-files --cached --others --exclude-standard` in `params.worktree` and returns the sorted, non-empty lines as a `GitFilesResult`. Falls back to a plain directory walk when `worktree` isn't a git repository; any other `git` failure still throws `GitExecError`. */
export async function getGitFiles(
  params: GitFilesParams,
  deps: GitFilesDeps = {},
): Promise<GitFilesResult> {
  const git = deps.git ?? runGit;
  const listPlainFiles = deps.listPlainFiles ?? listPlainFilesDefault;

  let output: string;
  try {
    output = await git(
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      params.worktree,
    );
  } catch (error) {
    if (error instanceof GitExecError && NOT_A_GIT_REPOSITORY_RE.test(error.message)) {
      return { files: (await listPlainFiles(params.worktree)).sort() };
    }
    throw error;
  }

  const files = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();

  return { files };
}
