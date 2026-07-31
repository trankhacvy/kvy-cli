import { describe, expect, it } from "vitest";
import { canMutateMode, nextModeAfterSetMode, shouldShowTakeControl } from "./mode-switch-state";
import { canMutateModel, nextModelAfterSetModel } from "./model-switch-state";
import {
  initialStopSessionDialogState,
  resetStopSessionDialogState,
  toStopError,
  toStopping,
} from "./stop-session-state";

describe("shouldShowTakeControl (W2.4 — hide Take-control in PTY mode)", () => {
  it("hides Take control for a PTY/local session — its takeControl RPC is a permanent no-op", () => {
    expect(shouldShowTakeControl("local", true)).toBe(false);
  });

  it("shows Take control for a genuine remote-loop session whose provider supports it", () => {
    expect(shouldShowTakeControl("remote", true)).toBe(true);
  });

  it("hides Take control for a remote-loop session whose provider has no local mode to hand back to (e.g. Codex)", () => {
    expect(shouldShowTakeControl("remote", false)).toBe(false);
  });
});

describe("canMutateMode (W2.4 — hide mode mutation until U4.5)", () => {
  it("disallows mutating the mode selector for a PTY/local session by default (flag off)", () => {
    expect(canMutateMode("local", true)).toBe(false);
  });

  it("allows mutating the mode selector for a remote-loop session — its setMode is real, flag or not", () => {
    expect(canMutateMode("remote", true)).toBe(true);
    expect(canMutateMode("remote", true, false)).toBe(true);
    expect(canMutateMode("remote", true, true)).toBe(true);
  });

  it("W4.3: un-hides the PTY/local mode selector once ptySetModeEnabled is true", () => {
    expect(canMutateMode("local", true, true)).toBe(true);
    expect(canMutateMode("local", true, false)).toBe(false);
  });

  it("stays disallowed regardless of controlMode/flag when the provider doesn't support live mode switching at all", () => {
    expect(canMutateMode("remote", false)).toBe(false);
    expect(canMutateMode("local", false, true)).toBe(false);
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

describe("nextModeAfterSetMode (W4.3 — revert an unconfirmed PTY mode switch)", () => {
  it("keeps the optimistically-selected target and clears the error on {ok:true}", () => {
    expect(nextModeAfterSetMode("plan", "default", { ok: true })).toEqual({
      mode: "plan",
      error: null,
    });
  });

  it("{ok:true} wins even if the RPC also reported an observedMode", () => {
    expect(
      nextModeAfterSetMode("plan", "default", { ok: true, observedMode: "acceptEdits" }),
    ).toEqual({ mode: "plan", error: null });
  });

  it("reverts to the RPC's observedMode on {ok:false} when one was reported", () => {
    expect(
      nextModeAfterSetMode("plan", "default", { ok: false, observedMode: "acceptEdits" }),
    ).toEqual({
      mode: "acceptEdits",
      error: "Could not confirm the mode switch. Reverted.",
    });
  });

  it("falls back to the prior selection on {ok:false} with no observedMode (verification timeout)", () => {
    expect(nextModeAfterSetMode("plan", "default", { ok: false })).toEqual({
      mode: "default",
      error: "Could not confirm the mode switch. Reverted.",
    });
  });
});

describe("canMutateModel (issue #12 — web model selector, PTY-only)", () => {
  it("disallows mutating the model selector for a local session by default (flag off)", () => {
    expect(canMutateModel("local", true)).toBe(false);
  });

  it("un-hides the model selector for a local session once ptySetModelEnabled is true", () => {
    expect(canMutateModel("local", true, true)).toBe(true);
  });

  it("never allows mutating the model selector for a remote-loop session, flag or not — setModel is PTY-only, unlike setMode", () => {
    expect(canMutateModel("remote", true)).toBe(false);
    expect(canMutateModel("remote", true, true)).toBe(false);
  });

  it("stays disallowed regardless of controlMode/flag when the provider doesn't support live model switching at all (e.g. Codex)", () => {
    expect(canMutateModel("local", false, true)).toBe(false);
    expect(canMutateModel("remote", false)).toBe(false);
  });
});

describe("nextModelAfterSetModel (issue #12 — model switch error surfacing)", () => {
  it("clears the error on {ok:true}", () => {
    expect(nextModelAfterSetModel({ ok: true, observedModel: "Sonnet 5" })).toEqual({
      error: null,
    });
    expect(nextModelAfterSetModel({ ok: true })).toEqual({ error: null });
  });

  it("surfaces an error on {ok:false}, regardless of any observedModel — it's free text, not a selectable value", () => {
    expect(nextModelAfterSetModel({ ok: false })).toEqual({
      error: "Could not confirm the model switch. Reverted.",
    });
    expect(nextModelAfterSetModel({ ok: false, observedModel: "Sonnet 5" })).toEqual({
      error: "Could not confirm the model switch. Reverted.",
    });
  });
});
