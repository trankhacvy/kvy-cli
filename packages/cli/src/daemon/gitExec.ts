/**
 * Shared `git` invocation helper for the daemon's `git.status`/`git.diff`
 * machine RPCs (`gitStatus.ts`/`gitDiff.ts`, design §4.4, plan.md §16 "4.1
 * Git panel"). Same hand-wrapped-`execFile` shape as
 * `gitWorktree.ts`'s own `runGit` (not `util.promisify`, for the same
 * mockability reason as `processScan.ts`'s `runPs`) — kept as a separate
 * copy here rather than importing `gitWorktree.ts`'s private helper, since
 * that module doesn't export one and status/diff reads have no reason to
 * couple to the worktree-creation module.
 */
import { execFile } from "node:child_process";

export class GitExecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitExecError";
  }
}

/** Runs `git <args>` in `cwd`, resolving stdout or rejecting with a `GitExecError` carrying git's own stderr. Injectable for tests. */
export type GitExec = (args: string[], cwd: string) => Promise<string>;

export const runGit: GitExec = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new GitExecError(stderr.toString().trim() || error.message));
          return;
        }
        resolve(stdout.toString());
      },
    );
  });
