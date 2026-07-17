import type { AdoptMode, AdoptTakeOutcome } from "./types";

/**
 * `TakeOverDialog`'s local phase machine, kept as a pure module so the
 * choose -> confirm -> success/error transitions (falcon-system-design.md
 * §10.4/§11 UC9, plan.md §16 "3.3 Session adoption (UC9)") are testable
 * without mounting the component — same precedent as
 * `features/session-control/perm-card-state.ts` /
 * `perm-card-state.test.ts`.
 */
export type DialogState =
  | { phase: "choose" }
  | { phase: "confirm"; mode: AdoptMode }
  | { phase: "success"; outcome: AdoptTakeOutcome; mode: AdoptMode }
  | { phase: "error"; message: string };

/** The dialog's phase the first time it mounts, and the phase it's reset to
 * on close (`handleOpenChange(false)`) so the next open starts fresh. */
export const initialDialogState: DialogState = { phase: "choose" };

/** Reset transition applied when the dialog closes — mirrors
 * `initialDialogState` but kept as its own named transition so the
 * "reset-on-close" behavior reads as intentional at the call site and in
 * tests, not just an incidental reuse of the initial value. */
export function resetDialogState(): DialogState {
  return { phase: "choose" };
}

/**
 * A running session only needs the extra confirm step for a takeover —
 * that's the destructive path (interrupts the live process); forking never
 * touches it, so it should go straight to the RPC call instead.
 */
export function needsRunningConfirm(mode: AdoptMode, running: boolean): boolean {
  return mode === "takeover" && running;
}

/** Transition into the "still running, are you sure?" confirm step. */
export function toConfirm(mode: AdoptMode): DialogState {
  return { phase: "confirm", mode };
}

/** "Back" from the confirm step returns to the initial choose step. */
export function toChoose(): DialogState {
  return { phase: "choose" };
}

/** Applies a successful `adopt.take` RPC round-trip. */
export function toSuccess(outcome: AdoptTakeOutcome, mode: AdoptMode): DialogState {
  return { phase: "success", outcome, mode };
}

/** Applies a failed `adopt.take` RPC round-trip (transport or app-level). */
export function toError(error: unknown): DialogState {
  return { phase: "error", message: error instanceof Error ? error.message : String(error) };
}
