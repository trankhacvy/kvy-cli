import { describe, expect, it } from "vitest";
import { canMutateMode, shouldShowTakeControl } from "./ControlBar";
import {
  initialStopSessionDialogState,
  resetStopSessionDialogState,
  toStopError,
  toStopping,
} from "./stop-session-state";

describe("shouldShowTakeControl (W2.4 — hide Take-control in PTY mode)", () => {
  it("hides Take control for a PTY/local session — its takeControl RPC is a permanent no-op", () => {
    expect(shouldShowTakeControl("local")).toBe(false);
  });

  it("shows Take control for a genuine remote-loop session", () => {
    expect(shouldShowTakeControl("remote")).toBe(true);
  });
});

describe("canMutateMode (W2.4 — hide mode mutation until U4.5)", () => {
  it("disallows mutating the mode selector for a PTY/local session — setMode always returns {ok:false} there", () => {
    expect(canMutateMode("local")).toBe(false);
  });

  it("allows mutating the mode selector for a remote-loop session — its setMode is real", () => {
    expect(canMutateMode("remote")).toBe(true);
  });
});

describe("End-session confirm dialog phase machine (W2.3 — dialog flow ordering)", () => {
  it("starts (and resets) at the 'confirm' phase — opening/re-opening never skips confirmation", () => {
    expect(initialStopSessionDialogState).toEqual({ phase: "confirm" });
    expect(resetStopSessionDialogState()).toEqual({ phase: "confirm" });
  });

  it("moves to 'stopping' only once the confirm button is actually pressed", () => {
    expect(toStopping()).toEqual({ phase: "stopping" });
  });

  it("a failed stop RPC carries its message and leaves the confirm step reachable again (retry, not stuck)", () => {
    expect(toStopError(new Error("machine offline"))).toEqual({
      phase: "error",
      message: "machine offline",
    });
  });

  it("falls back to String() for a non-Error throw", () => {
    expect(toStopError("boom")).toEqual({ phase: "error", message: "boom" });
  });
});
