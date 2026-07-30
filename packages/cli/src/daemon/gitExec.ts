/**
 * Shared `git` invocation helper for the daemon's `git.status`/`git.diff`
 * machine RPCs (`gitStatus.ts`/`gitDiff.ts`, design §4.4, plan.md §16 "4.1
 * Git panel"). Same hand-wrapped-`execFile` shape as
 * `gitWorktree.ts`'s own `runGit` (not `util.promisify`, for the same
 * mockability reason as `processScan.ts`'s `runPs`) — kept as a separate
 * copy here rather than importing `gitWorktree.ts`'s private helper, since
 * that module doesn't export one and status/diff reads have no reason to
 * couple to the worktree-creation module.
 *
 * `github.checks` (docs/features/github-pr-ci.md) is this helper's first
 * consumer that ever touches the network (`git ls-remote` against the
 * configured remote to distinguish "not-pushed" from "no-pr") — every prior
 * caller (`git status`/`git diff`/`git for-each-ref`) is purely local. A
 * headless, long-running daemon has no controlling terminal to answer a
 * credential prompt, so without `GIT_TERMINAL_PROMPT=0` a remote requiring
 * interactive auth (an HTTPS remote with no cached credential helper, or a
 * GUI `core.askpass` helper invoked anyway) could hang that RPC forever
 * rather than failing fast into the generic-error path
 * `getGithubChecks`'s doc comment already describes; `timeout` below is a
 * second, defense-in-depth bound against a network hang that isn't a
 * credential prompt at all (e.g. an unreachable host). Both are no-ops for
 * every existing local-only caller.
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

/** Bounds any single `git` invocation — see this module's doc comment ("first network-touching caller"). */
const GIT_EXEC_TIMEOUT_MS = 15_000;

export const runGit: GitExec = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: 20 * 1024 * 1024,
        timeout: GIT_EXEC_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
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
      },
    );
  });

/**
 * Like `runGit`, but for `git diff --no-index` invocations specifically
 * (`gitDiff.ts`/`gitStatus.ts`'s untracked-file handling — an untracked file
 * has no committed content on either side of a normal `git diff <ref>`, so
 * it's diffed against `/dev/null` instead, which is what `--no-index`
 * allows outside a real repo comparison). Unlike every other `git diff`
 * invocation in this codebase (which always exits 0, differences or not),
 * `--no-index` exits 1 the moment the two sides differ — the normal,
 * successful case here (there's always a difference: the "old" side is
 * always `/dev/null`), never a failure by itself. But exit 1 is NOT
 * unambiguous on its own: git also uses it for a real error (verified
 * against the real binary — `Could not access '<path>'` for a path that
 * vanished between the untracked-file scan and this diff also exits 1). The
 * real signal is where the output landed: a genuine diff writes to stdout
 * with an empty stderr; an error writes to stderr with an empty stdout. So
 * exit 1 only resolves when stderr is empty — any stderr output, or any
 * other exit code/spawn failure, is treated as a real error.
 */
export const runGitDiffNoIndex: GitExec = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: 20 * 1024 * 1024,
        timeout: GIT_EXEC_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error && error.code === 1 && stderr.toString().trim() === "") {
          resolve(stdout.toString());
          return;
        }
        if (error) {
          reject(
            new GitExecError(stderr.toString().trim() || stdout.toString().trim() || error.message),
          );
          return;
        }
        resolve(stdout.toString());
      },
    );
  });
