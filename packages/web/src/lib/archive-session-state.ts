import type { WorktreeRemoveResult } from "@falcon/wire";

/**
 * `useArchiveSession`'s phase machine. A clean worktree needs no confirm at
 * all — `"checking"` resolves straight to `"archiving"` on `removed: true`.
 * Only a dirty worktree (`requiresForce`) stops at `"confirm-force"`,
 * mirroring `remove-worktree-dialog-state.ts`'s own escalation shape.
 */
export type ArchiveSessionState =
  | { phase: "checking" }
  | { phase: "confirm-force" }
  | { phase: "archiving" }
  | { phase: "error"; message: string };

export const initialArchiveSessionState: ArchiveSessionState = { phase: "checking" };

export function toArchiving(): ArchiveSessionState {
  return { phase: "archiving" };
}

export function toArchiveError(error: unknown): ArchiveSessionState {
  return { phase: "error", message: error instanceof Error ? error.message : String(error) };
}

/** Maps a settled `WorktreeRemoveResult` to the next phase — `requiresForce` escalates to `"confirm-force"`; an actual removal (with or without a prior force retry) moves straight on to `"archiving"`. */
export function toStateAfterWorktreeRemove(result: WorktreeRemoveResult): ArchiveSessionState {
  if (!result.removed && result.requiresForce) {
    return { phase: "confirm-force" };
  }
  return toArchiving();
}
