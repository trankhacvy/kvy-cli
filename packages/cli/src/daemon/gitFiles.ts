/**
 * `git.files` machine RPC handler. Backs the web repo file tree.
 *
 * Uses `git ls-files --cached --others --exclude-standard` to list every
 * tracked + untracked (non-ignored) file without needing its own ignore parser.
 * For non-git directories, falls back to a plain recursive walk (with a
 * hardcoded skip list) rather than leaving the tab unusable. Any other git
 * failure (permissions, corrupt repo) throws through; only "not a git
 * repository" triggers the fallback.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { GitFilesParams, GitFilesResult } from "@kvy/wire";
import { type GitExec, GitExecError, runGit } from "./gitExec.js";

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
    output = await git(["ls-files", "--cached", "--others", "--exclude-standard"], params.worktree);
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
