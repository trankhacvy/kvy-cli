import type { AdoptMode, AdoptTakeOutcome } from "./types";

/** `TakeOverDialog`'s local phase machine, kept as a pure module so the
 * choose -> confirm -> success/error transitions are testable without mounting
 * the component. */
export type DialogState =
  | { phase: "choose" }
  | { phase: "confirm"; mode: AdoptMode }
  | { phase: "success"; outcome: AdoptTakeOutcome; mode: AdoptMode }
  | { phase: "error"; message: string };

export const initialDialogState: DialogState = { phase: "choose" };

export function resetDialogState(): DialogState {
  return { phase: "choose" };
}

/** Only a takeover of a still-running session needs the extra confirm step -
 * forking leaves the original alone, so it can skip straight to the RPC call. */
export function needsRunningConfirm(mode: AdoptMode, running: boolean): boolean {
  return mode === "takeover" && running;
}

export function toConfirm(mode: AdoptMode): DialogState {
  return { phase: "confirm", mode };
}

export function toChoose(): DialogState {
  return { phase: "choose" };
}

export function toSuccess(outcome: AdoptTakeOutcome, mode: AdoptMode): DialogState {
  return { phase: "success", outcome, mode };
}

export function toError(error: unknown): DialogState {
  return { phase: "error", message: error instanceof Error ? error.message : String(error) };
}
