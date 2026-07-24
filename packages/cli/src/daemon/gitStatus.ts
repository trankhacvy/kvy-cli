/**
 * `git.status` machine RPC handler (design §4.4: `'git.status'({worktree})
 * → { branch, ahead, behind, files: FileStatus[] }`; falcon-prd.md FR-7.7
 * "Git panel"; plan.md §16 "4.1 Git panel"). Backs the web changed-files
 * list.
 *
 * Parses `git status --porcelain=v2 --branch` — the stable, script-friendly
 * status format (unlike plain `--porcelain=v1`, v2 gives branch/ahead/behind
 * as its own header lines instead of requiring a second `git rev-list`
 * call). Every record type git can emit is handled explicitly (ordinary,
 * renamed/copied, unmerged, untracked) — an unrecognized line is skipped
 * rather than silently miscounted, since `FileStatusSchema`'s enum has no
 * "unknown" case to fall back to honestly.
 */
import type { FileStatus, GitStatusParams, GitStatusResult } from "@falcon/wire";
import { type GitExec, runGit } from "./gitExec.js";
import { assertWorkspaceStillValid } from "./workspacePath.js";

export interface GitStatusDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to `workspacePath.ts`'s real `assertWorkspaceStillValid` (known-issues.md #3 — a real filesystem check, so tests exercising the porcelain-parsing logic against a fake `worktree` path must override this). */
  assertWorkspaceValid?: (directory: string) => Promise<void>;
}

const ORDINARY_RE = /^1 (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/;
const RENAMED_RE = /^2 (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/;
const UNMERGED_RE = /^u (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/;
const UNTRACKED_RE = /^\? (.+)$/;
const BRANCH_HEAD_RE = /^# branch\.head (.+)$/;
const BRANCH_AB_RE = /^# branch\.ab \+(\d+) -(\d+)$/;

/** Maps a porcelain v2 `XY` code pair to Falcon's `FileStatus.status` enum — the enum has no separate "conflict" case, so an unmerged entry's `XY` (always some combination of `U`/`A`/`D`) reads as `modified`, the closest honest fit for a read-only MVP diff panel. */
function statusFromXY(xy: string): FileStatus["status"] {
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  return "modified";
}

/** Parses one `git status --porcelain=v2 --branch` line into a `FileStatus`, or `null` for a header/ignored line this handler doesn't surface (design: `FileStatus[]` covers tracked + untracked changes, not ignored files — `--ignored` is never passed to `git status` here). */
function parseFileLine(line: string): FileStatus | null {
  const ordinary = ORDINARY_RE.exec(line);
  if (ordinary) {
    const [, xy, path] = ordinary as unknown as [string, string, string];
    return { path, status: statusFromXY(xy) };
  }

  const renamed = RENAMED_RE.exec(line);
  if (renamed) {
    const [, , rest] = renamed as unknown as [string, string, string];
    const path = rest.split("\t")[0] ?? rest;
    return { path, status: "renamed" };
  }

  const unmerged = UNMERGED_RE.exec(line);
  if (unmerged) {
    const [, xy, path] = unmerged as unknown as [string, string, string];
    return { path, status: statusFromXY(xy) };
  }

  const untracked = UNTRACKED_RE.exec(line);
  if (untracked) {
    const [, path] = untracked as unknown as [string, string];
    return { path, status: "untracked" };
  }

  return null;
}

/** Runs `git status --porcelain=v2 --branch` in `params.worktree` and parses it into a `GitStatusResult`. Throws a `WorkspaceValidationError` (known-issues.md #3) if `worktree` no longer exists or isn't a git repository — checked before `git` ever runs, so the caller gets a typed reason instead of `git`'s raw stderr. Throws `GitExecError` for any other `git` failure — no silent "empty status" fallback. */
export async function getGitStatus(
  params: GitStatusParams,
  deps: GitStatusDeps = {},
): Promise<GitStatusResult> {
  const assertWorkspaceValid = deps.assertWorkspaceValid ?? assertWorkspaceStillValid;
  await assertWorkspaceValid(params.worktree);
  const git = deps.git ?? runGit;
  const output = await git(["status", "--porcelain=v2", "--branch"], params.worktree);

  let branch = "HEAD";
  let ahead = 0;
  let behind = 0;
  const files: FileStatus[] = [];

  for (const line of output.split("\n")) {
    if (line === "") continue;

    const headMatch = BRANCH_HEAD_RE.exec(line);
    if (headMatch) {
      branch = headMatch[1] as string;
      continue;
    }

    const abMatch = BRANCH_AB_RE.exec(line);
    if (abMatch) {
      ahead = Number(abMatch[1]);
      behind = Number(abMatch[2]);
      continue;
    }

    if (line.startsWith("#")) continue; // other header lines (branch.oid, branch.upstream)

    const file = parseFileLine(line);
    if (file) files.push(file);
  }

  return { branch, ahead, behind, files };
}
