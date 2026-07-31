/**
 * `git.status` machine RPC handler (design §4.4: `'git.status'({worktree})
 * → { branch, ahead, behind, files: FileStatus[] }`; falcon-prd.md FR-7.7
 * "Git panel"; plan.md §16 "4.1 Git panel"). Backs the web changed-files
 * list (conductor.build-style: everything different from the workspace's
 * base branch, not just uncommitted edits).
 *
 * The file list itself comes from a diff against the resolved base ref
 * (`gitBaseRef.ts`'s `resolveEffectiveBaseRef`/`resolveDiffBaseline` — same
 * resolution `gitDiff.ts` uses to build the actual per-file diff), not from
 * `git status`'s own porcelain output — a two-dot `git diff <ref>` already
 * captures both this branch's committed changes *and* in-progress
 * uncommitted edits (see `gitDiff.ts`'s own doc comment), which is what
 * makes a long-running agent session's Changes tab show everything since
 * branching off `main`, not just what's still sitting uncommitted.
 * `--no-renames` is deliberate: a rename shows up as a plain delete + add
 * pair instead of one "renamed" row, trading a little presentation nuance
 * for not having to reconcile old/new paths across two separately-parsed
 * `git diff` outputs (`--name-status` for the status letter, `--numstat`
 * for line counts).
 *
 * `git status --porcelain=v2 --branch` is still run, for three things a
 * ref-diff can't give: the current branch name + ahead/behind vs its
 * upstream (a local-vs-remote fact, unrelated to the base-ref comparison),
 * untracked files (invisible to `git diff`, which only ever compares
 * tracked content), and in-progress merge/rebase conflicts (a working-tree/
 * index state, not something meaningful to diff against a branch).
 * `--untracked-files=all` is required, not cosmetic: `git status`'s default
 * mode collapses an untracked directory into a single `? dir/` entry, and
 * `git diff --no-index` can't compare a file (`/dev/null`) against a
 * directory at all — verified against the real binary, it errors outright
 * (`Could not access 'dir/null'`) rather than partially working. `-uall`
 * lists every file inside individually, so every untracked path this
 * module ever sees is a real file.
 *
 * An untracked file's `insertions`/`deletions` come from a *separate*
 * per-file `git diff --no-index --numstat -- /dev/null <path>` call
 * (`gitExec.ts`'s `runGitDiffNoIndex` — see its own doc comment for why
 * `--no-index` needs different exit-code handling than every other `git
 * diff` call here), the same "diff against nothing" trick `gitDiff.ts` uses
 * to show a real diff for an untracked file on click, rather than the
 * folder-name-only badge with no stat this had before.
 */
import type { FileStatus, GitStatusParams, GitStatusResult } from "@falcon/wire";
import { resolveDiffBaseline, resolveEffectiveBaseRef } from "./gitBaseRef.js";
import { type GitExec, runGit, runGitDiffNoIndex } from "./gitExec.js";
import { parseUntrackedPath } from "./gitUntracked.js";
import { assertWorkspaceStillValid } from "./workspacePath.js";

export interface GitStatusDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to `gitExec.ts`'s real `runGitDiffNoIndex` (an untracked file's own `+N`/`-M` stat). */
  noIndexDiff?: GitExec;
  /** Injectable for tests; defaults to `workspaceConfig.ts`'s real `~/.falcon/settings.json`-backed lookup. */
  resolveConfiguredBaseRef?: (worktree: string) => Promise<string | undefined>;
  /** Injectable for tests; defaults to `workspacePath.ts`'s real `assertWorkspaceStillValid` (known-issues.md #3 — a real filesystem check, so tests exercising the porcelain-parsing logic against a fake `worktree` path must override this). */
  assertWorkspaceValid?: (directory: string) => Promise<void>;
}

const UNMERGED_RE = /^u (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/;
const BRANCH_HEAD_RE = /^# branch\.head (.+)$/;
const BRANCH_AB_RE = /^# branch\.ab \+(\d+) -(\d+)$/;

/** Maps a `git diff --name-status` letter to Falcon's `FileStatus.status` enum. `--no-renames` means `R`/`C` never appear here. */
function statusFromNameStatusLetter(letter: string): FileStatus["status"] {
  if (letter.startsWith("A")) return "added";
  if (letter.startsWith("D")) return "deleted";
  return "modified";
}

/** Parses `git diff --no-renames --name-status <ref>` output into an ordered `path -> status` map (tree order, i.e. already roughly alphabetical). */
function parseNameStatus(output: string): Map<string, FileStatus["status"]> {
  const byPath = new Map<string, FileStatus["status"]>();
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const [letter, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!letter || !path) continue;
    byPath.set(path, statusFromNameStatusLetter(letter));
  }
  return byPath;
}

/** Parses `git diff --no-renames --numstat <ref>` output into a `path -> {insertions, deletions}` map. A binary file reports `-`/`-` (not a real count) — left out of the map entirely, same as an untracked file, rather than coercing `-` to `0` and implying a false "no changes" count. */
function parseNumstat(output: string): Map<string, { insertions: number; deletions: number }> {
  const byPath = new Map<string, { insertions: number; deletions: number }>();
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const [insertions, deletions, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!insertions || !deletions || !path) continue;
    if (insertions === "-" || deletions === "-") continue;
    byPath.set(path, { insertions: Number(insertions), deletions: Number(deletions) });
  }
  return byPath;
}

/** Parses a `git diff --no-index --numstat -- /dev/null <path>` call's output into total counts — the caller already knows the path it asked for, `/dev/null => <path>` on every line is discarded either way. Normally exactly one line (`--untracked-files=all` guarantees `<path>` is a real file, never a directory), but summed rather than just reading the first regardless — defense in depth against ever silently under-counting again if that guarantee is ever violated. A binary line (`-`/`-`) contributes nothing; `null` only when there was no usable line at all. */
function parseSingleFileNumstat(output: string): { insertions: number; deletions: number } | null {
  let insertions = 0;
  let deletions = 0;
  let sawUsableLine = false;
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const [insertionsPart, deletionsPart] = line.split("\t");
    if (!insertionsPart || !deletionsPart) continue;
    if (insertionsPart === "-" || deletionsPart === "-") continue;
    insertions += Number(insertionsPart);
    deletions += Number(deletionsPart);
    sawUsableLine = true;
  }
  return sawUsableLine ? { insertions, deletions } : null;
}

/** Runs `git status --porcelain=v2 --branch` in `params.worktree` and `git diff` against the resolved base ref, merging them into a `GitStatusResult`. Throws a `WorkspaceValidationError` (known-issues.md #3) if `worktree` no longer exists or isn't a git repository — checked before `git` ever runs. Throws `GitExecError` for any other `git` failure — no silent "empty status" fallback. */
export async function getGitStatus(
  params: GitStatusParams,
  deps: GitStatusDeps = {},
): Promise<GitStatusResult> {
  const assertWorkspaceValid = deps.assertWorkspaceValid ?? assertWorkspaceStillValid;
  await assertWorkspaceValid(params.worktree);
  const git = deps.git ?? runGit;
  const noIndexDiff = deps.noIndexDiff ?? runGitDiffNoIndex;

  const statusOutput = await git(
    ["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
    params.worktree,
  );

  let branch = "HEAD";
  let ahead = 0;
  let behind = 0;
  const untrackedPaths: string[] = [];
  const unmerged: FileStatus[] = [];

  for (const line of statusOutput.split("\n")) {
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

    const untrackedPath = parseUntrackedPath(line);
    if (untrackedPath) {
      untrackedPaths.push(untrackedPath);
      continue;
    }

    const unmergedMatch = UNMERGED_RE.exec(line);
    if (unmergedMatch) {
      unmerged.push({ path: unmergedMatch[2] as string, status: "modified" });
    }
    // Ordinary ("1 ...") and renamed ("2 ...") lines are intentionally
    // skipped here — superseded by the base-ref diff below, which already
    // covers every tracked change (committed-on-branch or still
    // uncommitted) in one consistent comparison.
  }

  // Each untracked file gets its own `+N`/`-M` stat via a "diff against
  // nothing" call (`gitUntracked.ts`'s own doc comment) — `git diff <ref>`
  // can never see these paths at all, tracked-or-not, so there's no way to
  // fold this into the single combined ref-diff call above.
  const untracked: FileStatus[] = await Promise.all(
    untrackedPaths.map(async (path) => {
      const output = await noIndexDiff(
        ["diff", "--no-index", "--numstat", "--", "/dev/null", path],
        params.worktree,
      );
      const stat = parseSingleFileNumstat(output);
      return { path, status: "untracked" as const, ...(stat ?? {}) };
    }),
  );

  const resolvedBaseRef = await resolveEffectiveBaseRef(params.worktree, undefined, {
    git,
    resolveConfiguredBaseRef: deps.resolveConfiguredBaseRef,
  });
  const baseRef = resolvedBaseRef ?? (await resolveDiffBaseline(params.worktree, git));

  const [nameStatusOutput, numstatOutput] = await Promise.all([
    git(["diff", "--no-renames", "--name-status", baseRef], params.worktree),
    git(["diff", "--no-renames", "--numstat", baseRef], params.worktree),
  ]);
  const nameStatusByPath = parseNameStatus(nameStatusOutput);
  const numstatByPath = parseNumstat(numstatOutput);
  const unmergedPaths = new Set(unmerged.map((f) => f.path));

  const diffFiles: FileStatus[] = [];
  for (const [path, status] of nameStatusByPath) {
    if (unmergedPaths.has(path)) continue; // conflict state wins over the ref-diff's own classification
    const stat = numstatByPath.get(path);
    diffFiles.push({
      path,
      status,
      ...(stat ? { insertions: stat.insertions, deletions: stat.deletions } : {}),
    });
  }

  const files = [...diffFiles, ...unmerged, ...untracked].sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  return { branch, ahead, behind, files };
}
