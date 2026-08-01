import type { WorktreeRemoveResult } from "@kvy/wire";

/**
 * `useArchiveSession`'s phase machine — the single Archive action's whole
 * lifecycle (Home's `SessionCardActions` and the timeline header's
 * `SessionActionsMenu` both drive the same `ArchiveSessionDialog` off this).
 * Starts at `"confirm"` (nothing happens on menu-select alone) and only
 * moves once the user actually presses the button. A clean worktree (or no
 * worktree at all) sails through `"stopping"` → `"checking"` →
 * `"archiving"` on one click; only a dirty worktree (`requiresForce`) stops
 * at `"confirm-force"` for an explicit second confirmation before
 * discarding anything.
 */
export type ArchiveSessionState =
  | { phase: "confirm" }
  | { phase: "stopping" }
  | { phase: "checking" }
  | { phase: "confirm-force" }
  | { phase: "archiving" }
  | { phase: "error"; message: string };

export const initialArchiveSessionState: ArchiveSessionState = { phase: "confirm" };

export function resetArchiveSessionState(): ArchiveSessionState {
  return { phase: "confirm" };
}

export function toStopping(): ArchiveSessionState {
  return { phase: "stopping" };
}

export function toChecking(): ArchiveSessionState {
  return { phase: "checking" };
}

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
