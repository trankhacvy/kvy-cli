/**
 * Workspace-path validation for the daemon `spawn` RPC.
 *
 * Every spawn directory is checked against the locally registered root for its
 * `workspaceId` — the resolved real path (symlinks followed) must land inside
 * that root. This prevents `spawn` from being used as an arbitrary-directory
 * execution primitive for anyone who can reach the account's machine RPC target.
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
 * Typed reasons a previously-registered workspace's own directory can go stale.
 * A real error-code type (not just a message string) lets callers render
 * plain-language copy rather than relay raw `git` stderr.
 */
export type WorkspaceValidationErrorCode = "workspace-missing" | "workspace-not-a-repo";

/**
 * Thrown by `assertWorkspaceStillValid`. Special-cased in `machineRpc.ts`'s
 * catch block to attach `.code` to the error response, so clients can
 * distinguish workspace failures from ordinary git errors without string-matching.
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
 * git RPC shells out to it. A plain `stat`-based check - this only asks "does
 * this path still make sense to run `git` in", not whether it's inside any root.
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
