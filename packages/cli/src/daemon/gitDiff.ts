/**
 * `git.diff` machine RPC handler (design §4.4: `'git.diff'({worktree, path?,
 * baseRef?}) → { inline?, blobRef? }`; falcon-prd.md FR-7.7 "Git panel: ...
 * file-level diff list vs configured base ref, per-file unified diff view";
 * plan.md §16 "4.1 Git panel"). Backs the web unified diff viewer.
 *
 * **Base ref resolution** (falcon-prd.md line 148, `falcon workspace
 * config --base-ref`): an explicit `params.baseRef` always wins (a one-off
 * override, e.g. comparing against a different branch than the workspace's
 * configured default); otherwise falls back to the workspace's configured
 * base ref (`workspaceConfig.ts`, injectable here as
 * `deps.resolveConfiguredBaseRef` so tests don't need a real
 * `~/.falcon/settings.json`); with neither set, diffs against `HEAD`
 * (uncommitted changes only) — a repo with no configured base ref and no
 * override still gets a useful diff instead of an error.
 *
 * `git diff <ref>` (two-dot, not three-dot `<ref>...HEAD`) is deliberate:
 * it compares the working tree directly against `<ref>`'s tree, so the
 * result includes both the branch's committed changes *and* any
 * in-progress uncommitted edits — exactly what a live agent session's
 * "everything I've changed so far" panel wants, not just what's already
 * committed.
 *
 * **Truncation, not a blob upload:** the wire's `blobRef` is a reserved
 * extension point for the eventual blob-storage subsystem (plan.md §16
 * "4.3 Distribution & self-host", not yet built — same "unset until that
 * subsystem lands" state as `adopt.mirror`'s own `blobRef`). Until then, a
 * diff that would blow the 64KB RPC control-plane budget (design §4.4
 * "payload size rule") is truncated inline at a safe line boundary with
 * `truncated: true`, mirroring `fs.read`'s own `{inline, truncated}`
 * contract for the same not-yet-blob-backed situation.
 */
import type { GitDiffParams, GitDiffResult } from "@falcon/wire";
import { type GitExec, runGit } from "./gitExec.js";
import { readWorkspaceGitConfig } from "../workspaceConfig.js";

/** Stays well under the 64KB RPC control-plane cap (design §4.4) after JSON envelope + encryption overhead. */
const MAX_INLINE_BYTES = 60_000;

export interface GitDiffDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Looks up the workspace's configured base ref for `worktree`; defaults to `workspaceConfig.ts`'s real `~/.falcon/settings.json`-backed lookup. Returns `undefined` when none is configured. */
  resolveConfiguredBaseRef?: (worktree: string) => Promise<string | undefined>;
  maxInlineBytes?: number;
}

async function defaultResolveConfiguredBaseRef(worktree: string): Promise<string | undefined> {
  const config = await readWorkspaceGitConfig(worktree);
  return config?.baseRef;
}

/** Truncates `text` to fit `maxBytes` (UTF-8), backing off to the last full line so the result stays readable, and appends an explicit marker. */
function truncateToByteBudget(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  const lastNewline = cut.lastIndexOf("\n");
  const safe = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
  return { text: `${safe}\n\n… (diff truncated at ${maxBytes} bytes)\n`, truncated: true };
}

/** Runs `git diff` for `params.worktree` (optionally scoped to `params.path`) against the resolved base ref, returning an inline (possibly truncated) unified diff. Throws `GitExecError` on any `git` failure (not a repo, unknown ref, etc.) — no silent empty-diff fallback. */
export async function getGitDiff(params: GitDiffParams, deps: GitDiffDeps = {}): Promise<GitDiffResult> {
  const git = deps.git ?? runGit;
  const resolveConfiguredBaseRef = deps.resolveConfiguredBaseRef ?? defaultResolveConfiguredBaseRef;
  const maxInlineBytes = deps.maxInlineBytes ?? MAX_INLINE_BYTES;

  const baseRef = params.baseRef ?? (await resolveConfiguredBaseRef(params.worktree));

  const args = baseRef ? ["diff", baseRef] : ["diff", "HEAD"];
  if (params.path) args.push("--", params.path);

  const output = await git(args, params.worktree);
  const { text, truncated } = truncateToByteBudget(output, maxInlineBytes);

  return { inline: text, truncated };
}
