/**
 * Workspace-path validation for the daemon `spawn` RPC (design §12: "spawn
 * params validated against registered workspace paths (no arbitrary-
 * directory execution from remote)"; plan.md §16 "3.1 Remote spawn").
 *
 * A `spawn` RPC arrives over the relay from a remote client — the daemon
 * must never treat its `directory` field as a bare, trusted filesystem path:
 * that would make `spawn` an arbitrary-directory (and therefore effectively
 * arbitrary-command-context) execution primitive for anyone who can reach
 * the account's machine RPC target. Instead every call is checked against
 * the *locally* registered root for its `workspaceId` — a workspace the
 * account has actually configured on this machine (`kvy workspace
 * config`, a separate plan bullet) — and the resolved real path (symlinks
 * followed) must land inside that root.
 *
 * `lookupRoot` is injected rather than hard-coded to a specific registry
 * implementation: this module only owns the validation policy, not where
 * "registered workspaces" are persisted.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export type WorkspaceRootLookup = (workspaceId: string) => string | null | Promise<string | null>;

export type ValidateSpawnWorkspaceResult =
  | { ok: true; realDirectory: string }
  | {
      ok: false;
      reason:
        | "not-absolute"
        | "unknown-workspace"
        | "not-found"
        | "not-directory"
        | "outside-workspace-root";
    };

/**
 * Validates that `directory` is a real, existing directory inside the root
 * registered for `workspaceId`. Resolves both sides via `realpath` before
 * comparing, so a symlink (in either the workspace root or the requested
 * directory) can't be used to escape the root undetected.
 */
export async function validateSpawnWorkspace(
  params: { workspaceId: string; directory: string },
  lookupRoot: WorkspaceRootLookup,
): Promise<ValidateSpawnWorkspaceResult> {
  if (!path.isAbsolute(params.directory)) {
    return { ok: false, reason: "not-absolute" };
  }

  const root = await lookupRoot(params.workspaceId);
  if (root === null || root === undefined) {
    return { ok: false, reason: "unknown-workspace" };
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, reason: "unknown-workspace" };
  }

  let realDirectory: string;
  try {
    realDirectory = await realpath(params.directory);
  } catch {
    return { ok: false, reason: "not-found" };
  }

  const stats = await stat(realDirectory).catch(() => null);
  if (!stats?.isDirectory()) {
    return { ok: false, reason: "not-directory" };
  }

  const relative = path.relative(realRoot, realDirectory);
  const isInsideRoot =
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!isInsideRoot) {
    return { ok: false, reason: "outside-workspace-root" };
  }

  return { ok: true, realDirectory };
}

/**
 * Typed reasons a previously-registered workspace's own directory can go
 * stale after registration — see `assertWorkspaceStillValid` below
 * (known-issues.md #3: "Registered workspaces never re-validate their
 * path"). Kept as a real error-code enum (not just a message string) so a
 * caller several layers away — the web Git panel, across the encrypted RPC
 * boundary — can render plain-language copy instead of relaying whatever
 * `git`'s own stderr happened to say.
 */
export type WorkspaceValidationErrorCode = "workspace-missing" | "workspace-not-a-repo";

/**
 * Thrown by `assertWorkspaceStillValid`. `machineRpc.ts`'s `onRpcRequest`
 * catch block special-cases this (vs. any other thrown `Error`, e.g. a plain
 * `GitExecError`) to attach `.code` to the sealed error box it sends back,
 * so the web client can distinguish "this workspace is gone" from an
 * ordinary git failure without string-matching error text.
 */
export class WorkspaceValidationError extends Error {
  constructor(
    message: string,
    public readonly code: WorkspaceValidationErrorCode,
  ) {
    super(message);
    this.name = "WorkspaceValidationError";
  }
}

/**
 * Confirms `directory` still exists and is still a git repository before a
 * git RPC (`gitStatus.ts`/`gitDiff.ts`) shells out to it. Without this
 * check, a folder that was renamed, moved, or had `.git` removed after it
 * was registered surfaces as `git`'s own raw stderr (e.g. "fatal: cannot
 * change to '...': No such file or directory" or "fatal: not a git
 * repository") — confusing, technical, and not actionable from the web UI.
 * Deliberately a plain `stat`-based check, not `validateSpawnWorkspace`'s
 * realpath/containment logic above: this only asks "does this exact path
 * still make sense to run `git` in", not "is it still inside some other
 * root".
 */
export async function assertWorkspaceStillValid(directory: string): Promise<void> {
  const stats = await stat(directory).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new WorkspaceValidationError(
      `workspace directory not found: ${directory}`,
      "workspace-missing",
    );
  }

  const hasGitDir = await stat(path.join(directory, ".git")).then(
    () => true,
    () => false,
  );
  if (!hasGitDir) {
    throw new WorkspaceValidationError(
      `workspace is no longer a git repository: ${directory}`,
      "workspace-not-a-repo",
    );
  }
}
