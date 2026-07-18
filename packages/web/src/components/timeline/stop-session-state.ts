/**
 * `ControlBar`'s "End session" confirm dialog phase machine (plan-v2.md
 * W2.3 "Stop session from the web"). Kept as a pure module — same
 * precedent as `features/unmanaged-sessions/take-over-dialog-state.ts` /
 * `features/session-control/perm-card-state.ts` — so the
 * confirm -> stopping -> error ordering is directly testable
 * (`ControlBar.test.ts`) without mounting the component (this package has
 * no RTL/jsdom test setup — see `vitest.config.ts`).
 */
export type StopSessionPhase = "confirm" | "stopping" | "error";

export interface StopSessionDialogState {
  phase: StopSessionPhase;
  message?: string;
}

/** The dialog's phase the first time it opens, and the phase it's reset to
 * on close — so cancelling (or a later re-open after a prior error) always
 * starts from a fresh confirm step rather than replaying stale state. */
export const initialStopSessionDialogState: StopSessionDialogState = { phase: "confirm" };

export function resetStopSessionDialogState(): StopSessionDialogState {
  return { phase: "confirm" };
}

/** Entered the moment "End session" is actually confirmed — before the stop
 * RPC settles, so the confirm button can't be double-pressed into sending
 * two `stop` calls for one click. */
export function toStopping(): StopSessionDialogState {
  return { phase: "stopping" };
}

/** A failed stop RPC returns to a state that still shows the confirm step
 * (so the user can retry) plus the error message to display. */
export function toStopError(error: unknown): StopSessionDialogState {
  return { phase: "error", message: error instanceof Error ? error.message : String(error) };
}
