/**
 * Shared "which paths are untracked" logic for `gitStatus.ts`/`gitDiff.ts`
 * (kvy-prd.md FR-7.7). An untracked file is invisible to `git diff`
 * regardless of what ref it's compared against — verified against the real
 * binary: `git diff <any-ref>` never lists it, staged or not, because
 * `git diff` only ever considers paths that are tracked on at least one
 * side (the ref's tree or the index). Both callers diff an untracked path
 * against `/dev/null` instead (`gitExec.ts`'s `runGitDiffNoIndex`), which is
 * the only way to get a real diff/line-count for it without requiring the
 * user to `git add` it first.
 *
 * `--untracked-files=all` is required on every `git status` call this
 * produces or reads: the default mode collapses an untracked directory into
 * one `? dir/` entry, and `git diff --no-index` can't compare a file
 * (`/dev/null`) against a directory at all (verified against the real
 * binary — it errors, doesn't partially diff). `-uall` guarantees every
 * path this module hands back is a real file.
 */
import type { GitExec } from "./gitExec.js";

const UNTRACKED_RE = /^\? (.+)$/;

/** Parses one `git status --porcelain=v2 --untracked-files=all` line, returning the path for an untracked ("?") entry, or `null` for anything else (a header, an ordinary/renamed/unmerged record). */
export function parseUntrackedPath(line: string): string | null {
  const match = UNTRACKED_RE.exec(line);
  return match ? (match[1] as string) : null;
}

/** Runs its own `git status --porcelain=v2 --untracked-files=all` and returns every untracked path — for a caller (`gitDiff.ts`) that has no other reason to already have that output on hand. `gitStatus.ts` parses the same line shape (`parseUntrackedPath`) straight off the porcelain output it fetches for its own purposes (with the same flag), rather than paying for a second `git status` invocation here. */
export async function listUntrackedFiles(worktree: string, git: GitExec): Promise<string[]> {
  const output = await git(["status", "--porcelain=v2", "--untracked-files=all"], worktree);
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    const path = parseUntrackedPath(line);
    if (path) paths.push(path);
  }
  return paths;
}
