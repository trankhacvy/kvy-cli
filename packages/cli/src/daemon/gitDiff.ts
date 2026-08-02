/**
 * file-level diff list vs configured base ref, per-file unified diff view";
 *
 * config --base-ref`) is shared with `gitStatus.ts` via `gitBaseRef.ts`:
 * an explicit `params.baseRef` always wins (a one-off override, e.g.
 * comparing against a different branch than the workspace's configured
 * default); otherwise the workspace's configured base ref
 * (`workspaceConfig.ts`); otherwise a local `main`/`master` branch, whichever
 * exists (no remote lookup needed); otherwise `HEAD` — or, for a repo with
 * no commits at all yet, git's empty-tree hash, since `HEAD` doesn't resolve
 * to anything there (`fatal: bad revision 'HEAD'` was the crash before this
 * fallback existed).
 *
 * `git diff <ref>` (two-dot, not three-dot `<ref>...HEAD`) is deliberate:
 * it compares the working tree directly against `<ref>`'s tree, so the
 * result includes both the branch's committed changes *and* any
 * in-progress uncommitted edits — exactly what a live agent session's
 * "everything I've changed so far" panel wants, not just what's already
 * committed.
 *
 * **Untracked files are a special case** (`gitUntracked.ts`'s own doc
 * comment): `git diff <ref>` can never see one, tracked-or-not — verified
 * against the real binary. A `params.path` that's currently untracked is
 * instead diffed against `/dev/null` (`gitExec.ts`'s `runGitDiffNoIndex`),
 * which shows the whole file as newly added rather than the misleading
 * empty diff `git diff <ref> -- <path>` would otherwise return. The
 * no-`path` "every changed file" combined diff appends each untracked
 * file's own `/dev/null` diff after the regular ref-diff, for the same
 * reason — otherwise a session whose only change so far is one brand-new
 * untracked file would show "no differences" there despite the Changes
 * tab's own file list correctly listing it.
 *
 * **Truncation, plus a best-effort blob upload:** a diff that would blow
 * always truncated inline at a safe line boundary with `truncated: true`
 * (mirroring `fs.read`'s own `{inline, truncated}` contract) — that inline
 * preview is served unconditionally so the panel always has *something* to
 * show immediately, with no round trip. When `deps.uploadBlob` is wired
 * (`machineIntegration.ts`, once a live machine DEK/server connection
 * exists), the *full* untruncated diff is also encrypted and uploaded via
 * and its `blobId` set as `blobRef` — the caller can then fetch the
 * complete diff instead of settling for the truncated preview. Best-effort:
 * `deps.uploadBlob` never throws (see `blobClient.ts`'s own contract), so a
 * failed/unwired upload just leaves `blobRef` unset, same as before this
 * subsystem existed.
 */
import type { GitDiffParams, GitDiffResult } from "@kvy/wire";
import { resolveDiffBaseline, resolveEffectiveBaseRef } from "./gitBaseRef.js";
import { type GitExec, GitExecError, runGit, runGitDiffNoIndex } from "./gitExec.js";
import { listUntrackedFiles } from "./gitUntracked.js";
import { assertWorkspaceStillValid } from "./workspacePath.js";

const MAX_INLINE_BYTES = 60_000;

export interface GitDiffDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to `gitExec.ts`'s real `runGitDiffNoIndex` (an untracked file's own diff against `/dev/null`). */
  noIndexDiff?: GitExec;
  /** Looks up the workspace's configured base ref for `worktree`; defaults to `workspaceConfig.ts`'s real `~/.kvy/settings.json`-backed lookup. Returns `undefined` when none is configured. */
  resolveConfiguredBaseRef?: (worktree: string) => Promise<string | undefined>;
  maxInlineBytes?: number;
  /** Encrypts+uploads the full diff and resolves its `blobId`, or `null` on any failure — see `blobClient.ts`'s `uploadBlob`. No default: unset (the state every caller had before this subsystem existed) means `blobRef` simply stays unset, never a thrown error. Only ever called when the diff was actually truncated — a diff that already fits inline has no need for a blob. */
  uploadBlob?: (plaintext: Uint8Array) => Promise<string | null>;
  /** Injectable for tests; defaults to `workspacePath.ts`'s real `assertWorkspaceStillValid` (known-issues.md #3 — a real filesystem check, so tests exercising diff-building logic against a fake `worktree` path must override this). */
  assertWorkspaceValid?: (directory: string) => Promise<void>;
}

/** A single untracked path's diff against `/dev/null` — shows the whole file as newly added. */
function diffUntrackedPath(noIndexDiff: GitExec, worktree: string, path: string): Promise<string> {
  return noIndexDiff(["diff", "--no-index", "--", "/dev/null", path], worktree);
}

/** Truncates `text` to fit `maxBytes` (UTF-8), backing off to the last full line so the result stays readable, and appends an explicit marker. */
function truncateToByteBudget(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  const lastNewline = cut.lastIndexOf("\n");
  const safe = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
  return { text: `${safe}\n\n… (diff truncated at ${maxBytes} bytes)\n`, truncated: true };
}

/**
 * A `baseRef` passed straight through as `git diff <baseRef>` with no
 * disambiguating `--` before it (unlike `params.path`, which always gets
 * one — see below) would let a ref starting with `-` be parsed as a `git
 * diff` *option* instead of a revision — e.g. `--output=<file>` writes the
 * diff to an arbitrary file instead of returning it. `baseRef` comes
 * straight off the wire (`GitDiffParams.baseRef`) or `workspaceConfig.ts`'s
 * stored `--base-ref`, neither of which constrains its shape, so this is
 * checked the same way `gitWorktree.ts`'s `assertSafeBranchName` guards its
 * own user-controlled ref-like string.
 */
function isSafeRevision(ref: string): boolean {
  return ref.trim() !== "" && !ref.startsWith("-");
}

/** Runs `git diff` for `params.worktree` (optionally scoped to `params.path`) against the resolved base ref, returning an inline (possibly truncated) unified diff. Throws a `WorkspaceValidationError` (known-issues.md #3) if `worktree` no longer exists or isn't a git repository — checked before `git` ever runs. Throws `GitExecError` for any other `git` failure (unknown ref, etc.) or an unsafe `baseRef` — no silent empty-diff fallback. */
export async function getGitDiff(
  params: GitDiffParams,
  deps: GitDiffDeps = {},
): Promise<GitDiffResult> {
  const assertWorkspaceValid = deps.assertWorkspaceValid ?? assertWorkspaceStillValid;
  await assertWorkspaceValid(params.worktree);
  const git = deps.git ?? runGit;
  const noIndexDiff = deps.noIndexDiff ?? runGitDiffNoIndex;
  const maxInlineBytes = deps.maxInlineBytes ?? MAX_INLINE_BYTES;

  const resolvedBaseRef = await resolveEffectiveBaseRef(params.worktree, params.baseRef, {
    git,
    resolveConfiguredBaseRef: deps.resolveConfiguredBaseRef,
  });
  const baseRef = resolvedBaseRef ?? (await resolveDiffBaseline(params.worktree, git));
  if (!isSafeRevision(baseRef)) {
    throw new GitExecError(`unsafe base ref: ${baseRef}`);
  }

  const untrackedPaths = await listUntrackedFiles(params.worktree, git);

  let output: string;
  if (params.path && untrackedPaths.includes(params.path)) {
    output = await diffUntrackedPath(noIndexDiff, params.worktree, params.path);
  } else {
    const args = ["diff", baseRef];
    if (params.path) args.push("--", params.path);
    const trackedOutput = await git(args, params.worktree);

    if (params.path) {
      output = trackedOutput;
    } else {
      const untrackedOutputs = await Promise.all(
        untrackedPaths.map((path) => diffUntrackedPath(noIndexDiff, params.worktree, path)),
      );
      output = [trackedOutput, ...untrackedOutputs].filter((part) => part.trim() !== "").join("\n");
    }
  }

  const { text, truncated } = truncateToByteBudget(output, maxInlineBytes);

  let blobRef: string | undefined;
  if (truncated && deps.uploadBlob) {
    blobRef = (await deps.uploadBlob(new TextEncoder().encode(output))) ?? undefined;
  }

  return { inline: text, truncated, blobRef };
}
