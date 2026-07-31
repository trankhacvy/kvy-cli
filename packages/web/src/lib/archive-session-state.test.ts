import { describe, expect, it } from "vitest";
import {
  initialArchiveSessionState,
  toArchiveError,
  toArchiving,
  toStateAfterWorktreeRemove,
} from "./archive-session-state";

describe("initialArchiveSessionState", () => {
  it("starts at checking", () => {
    expect(initialArchiveSessionState).toEqual({ phase: "checking" });
  });
});

describe("toArchiving", () => {
  it("enters the in-flight phase with no message", () => {
    expect(toArchiving()).toEqual({ phase: "archiving" });
  });
});

describe("toArchiveError", () => {
  it("carries an Error's message through", () => {
    expect(toArchiveError(new Error("boom"))).toEqual({ phase: "error", message: "boom" });
  });

  it("stringifies a non-Error throw", () => {
    expect(toArchiveError("plain string")).toEqual({ phase: "error", message: "plain string" });
  });
});

describe("toStateAfterWorktreeRemove", () => {
  it("escalates to confirm-force when the RPC reports requiresForce (dirty worktree)", () => {
    expect(toStateAfterWorktreeRemove({ removed: false, requiresForce: true })).toEqual({
      phase: "confirm-force",
    });
  });

  it("moves straight to archiving on a plain successful removal (clean worktree)", () => {
    expect(toStateAfterWorktreeRemove({ removed: true })).toEqual({ phase: "archiving" });
  });

  it("moves straight to archiving after a force removal too", () => {
    expect(toStateAfterWorktreeRemove({ removed: true, branchDeleted: false })).toEqual({
      phase: "archiving",
    });
  });
});
