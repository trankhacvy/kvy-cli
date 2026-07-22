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

/** Runs `git <args>` in `cwd`, resolving stdout or rejecting with a `GitExecError` carrying git's own failure message. Injectable for tests. */
export type GitExec = (args: string[], cwd: string) => Promise<string>;

export const runGit: GitExec = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // Most `git` failures (e.g. `fatal: ...`) write to stderr, but some —
        // notably `git commit` on a clean tree, which prints "nothing to
        // commit, working tree clean" and exits non-zero — write their
        // whole message to STDOUT instead, leaving stderr empty. Falling
        // back to only `error.message` (Node's generic "Command failed:
        // git commit ..." wrapper text) in that case silently breaks any
        // caller matching on git's actual wording — `gitCommit.ts`'s
        // `NOTHING_TO_COMMIT_RE` in particular, which would otherwise never
        // match in the single most common real-world case it exists for.
        reject(
          new GitExecError(stderr.toString().trim() || stdout.toString().trim() || error.message),
        );
        return;
      }
      resolve(stdout.toString());
    });
  });
