import type { WorktreeRemoveResult } from "@falcon/wire";

/**
 * `RemoveWorktreeDialog`'s phase machine (Phase C, new-session-from-web
 * redesign — see `worktreeRemove.ts`'s own doc comment for the RPC this
 * drives). Pure module, same "state machine lives outside the component"
 * precedent as `components/timeline/stop-session-state.ts` — this package
 * has no jsdom/`@testing-library/react`, so the phase transitions are
 * directly unit-testable here without mounting anything.
 *
 * Root CLAUDE.md's "never put a destructive action next to a safe one"
 * principle drives the shape: `"confirm"` is the safe, primary step
 * (removing just the worktree directory); a `requiresForce` RPC result
 * (uncommitted/untracked changes present) escalates to the separate,
 * harder `"confirm-force"` step rather than silently retrying with
 * `force: true` — discarding uncommitted work needs its own, more explicit
 * confirmation. Branch deletion (`deleteBranch`) is a THIRD, independent
 * opt-in choice the caller surfaces as its own checkbox, off by default —
 * not part of this phase machine at all, since it's a per-attempt
 * parameter, not a distinct confirmation step of its own.
 */
export type RemoveWorktreeDialogState =
  | { phase: "confirm" }
  | { phase: "removing" }
  | { phase: "confirm-force" }
  | { phase: "removing-force" }
  | { phase: "error"; message: string }
  | { phase: "done"; branchDeleted?: boolean };

export const initialRemoveWorktreeDialogState: RemoveWorktreeDialogState = { phase: "confirm" };

export function resetRemoveWorktreeDialogState(): RemoveWorktreeDialogState {
  return { phase: "confirm" };
}

export function toRemoving(): RemoveWorktreeDialogState {
  return { phase: "removing" };
}

export function toRemovingForce(): RemoveWorktreeDialogState {
  return { phase: "removing-force" };
}

export function toRemoveError(error: unknown): RemoveWorktreeDialogState {
  return { phase: "error", message: error instanceof Error ? error.message : String(error) };
}

/** Maps a settled `WorktreeRemoveResult` to the next phase — `requiresForce` escalates to the harder confirm step; an actual removal (with or without a prior force retry) settles as `"done"`. */
export function toRemoveResultState(result: WorktreeRemoveResult): RemoveWorktreeDialogState {
  if (!result.removed && result.requiresForce) {
    return { phase: "confirm-force" };
  }
  return { phase: "done", branchDeleted: result.branchDeleted };
}
