import { describe, expect, it } from "vitest";
import { canMutateMode, shouldShowTakeControl } from "./ControlBar";

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
