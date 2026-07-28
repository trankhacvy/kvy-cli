import { describe, expect, it } from "vitest";
import {
  initialRemoveWorktreeDialogState,
  resetRemoveWorktreeDialogState,
  toRemoveError,
  toRemoveResultState,
  toRemoving,
  toRemovingForce,
} from "./remove-worktree-dialog-state";

describe("initialRemoveWorktreeDialogState / resetRemoveWorktreeDialogState", () => {
  it("both start at the safe confirm phase", () => {
    expect(initialRemoveWorktreeDialogState).toEqual({ phase: "confirm" });
    expect(resetRemoveWorktreeDialogState()).toEqual({ phase: "confirm" });
  });
});

describe("toRemoving / toRemovingForce", () => {
  it("enter the in-flight phases with no message", () => {
    expect(toRemoving()).toEqual({ phase: "removing" });
    expect(toRemovingForce()).toEqual({ phase: "removing-force" });
  });
});

describe("toRemoveError", () => {
  it("carries an Error's message through", () => {
    expect(toRemoveError(new Error("boom"))).toEqual({ phase: "error", message: "boom" });
  });

  it("stringifies a non-Error throw", () => {
    expect(toRemoveError("plain string")).toEqual({ phase: "error", message: "plain string" });
  });
});

describe("toRemoveResultState", () => {
  it("escalates to confirm-force when the RPC reports requiresForce (dirty worktree)", () => {
    expect(toRemoveResultState({ removed: false, requiresForce: true })).toEqual({
      phase: "confirm-force",
    });
  });

  it("settles as done on a plain successful removal", () => {
    expect(toRemoveResultState({ removed: true })).toEqual({
      phase: "done",
      branchDeleted: undefined,
    });
  });

  it("settles as done and reports branchDeleted:true when the branch was also deleted", () => {
    expect(toRemoveResultState({ removed: true, branchDeleted: true })).toEqual({
      phase: "done",
      branchDeleted: true,
    });
  });

  it("settles as done and reports branchDeleted:false when branch deletion was requested but failed", () => {
    expect(toRemoveResultState({ removed: true, branchDeleted: false })).toEqual({
      phase: "done",
      branchDeleted: false,
    });
  });
});
