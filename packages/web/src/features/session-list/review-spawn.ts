import type { SpawnRequest } from "../new-session";
import { parentWorktreePath } from "./worktree-path";

/**
 * Builds the `spawn` request for the "Review" action (session-panel-workflow-
 * of the coding session's, both hanging directly off the same repo root —
 * never the coding session's own worktree directory (`spawnEngine.ts`'s
 * directory-dedup guard would return the already-live coding session
 * instead of spawning anything there). `permissionMode: "plan"` is a
 * starting mode only, not a verified sandbox — `setMode`/a passthrough flag
 * can change it later.
 *
 * Returns `null` when `workspacePath` isn't actually a worktree path
 * (`parentWorktreePath` has nothing to re-parent onto) — defensive only:
 * the caller only ever invokes this once `looksLikeWorktreePath(workspacePath)`
 * has already gated the "Review" action's visibility, which guarantees this
 * never happens in practice.
 */
export function buildReviewSpawnRequest(
  workspacePath: string,
  codingBranch: string,
  now: () => number = Date.now,
): SpawnRequest | null {
  const repoRoot = parentWorktreePath(workspacePath);
  if (!repoRoot) return null;
  return {
    directory: repoRoot,
    provider: "claude-code",
    permissionMode: "plan",
    branch: {
      name: `review/${codingBranch}-${now()}`,
      createWorktree: true,
      from: codingBranch,
    },
  };
}
