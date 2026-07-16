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
 * account has actually configured on this machine (`falcon workspace
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
