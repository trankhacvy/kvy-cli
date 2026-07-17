import { describe, expect, it } from "vitest";
import {
  initialDialogState,
  needsRunningConfirm,
  resetDialogState,
  toChoose,
  toConfirm,
  toError,
  toSuccess,
} from "../take-over-dialog-state";
import type { AdoptTakeOutcome } from "../types";

describe("needsRunningConfirm", () => {
  it("requires confirmation for a takeover of a running session", () => {
    expect(needsRunningConfirm("takeover", true)).toBe(true);
  });

  it("skips confirmation for a takeover of a non-running session", () => {
    expect(needsRunningConfirm("takeover", false)).toBe(false);
  });

  it("never requires confirmation for a fork, running or not", () => {
    expect(needsRunningConfirm("fork", true)).toBe(false);
    expect(needsRunningConfirm("fork", false)).toBe(false);
  });
});

describe("initialDialogState / resetDialogState", () => {
  it("both start at the 'choose' phase", () => {
    expect(initialDialogState).toEqual({ phase: "choose" });
    expect(resetDialogState()).toEqual({ phase: "choose" });
  });
});

describe("toConfirm / toChoose", () => {
  it("carries the mode into the confirm phase", () => {
    expect(toConfirm("takeover")).toEqual({ phase: "confirm", mode: "takeover" });
  });

  it("'Back' returns to the choose phase, dropping the mode", () => {
    expect(toChoose()).toEqual({ phase: "choose" });
  });
});

describe("toSuccess", () => {
  it("carries the outcome (including a mid-turn warning) and mode into the success phase", () => {
    const outcome: AdoptTakeOutcome = { sessionId: "sess-1", warning: "interrupted a live turn" };
    expect(toSuccess(outcome, "takeover")).toEqual({
      phase: "success",
      outcome,
      mode: "takeover",
    });
  });

  it("carries an outcome with no warning through untouched", () => {
    const outcome: AdoptTakeOutcome = { sessionId: "sess-2" };
    expect(toSuccess(outcome, "fork")).toEqual({
      phase: "success",
      outcome,
      mode: "fork",
    });
  });
});

describe("toError", () => {
  it("carries an Error's message", () => {
    expect(toError(new Error("machine offline"))).toEqual({
      phase: "error",
      message: "machine offline",
    });
  });

  it("falls back to String() for a non-Error throw", () => {
    expect(toError("boom")).toEqual({ phase: "error", message: "boom" });
  });
});
