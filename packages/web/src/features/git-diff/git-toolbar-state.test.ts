import { describe, expect, it } from "vitest";
import { resolveBranchRenameSubmit, resolveCommitSubmit } from "./git-toolbar-state";

describe("resolveBranchRenameSubmit", () => {
  it("returns null (no-op) for an empty/whitespace-only draft", () => {
    expect(resolveBranchRenameSubmit("", "main")).toBeNull();
    expect(resolveBranchRenameSubmit("   ", "main")).toBeNull();
  });

  it("returns null (no-op) when the draft equals the current branch", () => {
    expect(resolveBranchRenameSubmit("main", "main")).toBeNull();
  });

  it("returns the trimmed name to rename to when it differs from the current branch", () => {
    expect(resolveBranchRenameSubmit("renamed", "main")).toBe("renamed");
    expect(resolveBranchRenameSubmit("  renamed  ", "main")).toBe("renamed");
  });
});

describe("resolveCommitSubmit", () => {
  it("returns null (no-op — mirrors the Commit button's disabled state) for an empty/whitespace-only message", () => {
    expect(resolveCommitSubmit("", true)).toBeNull();
    expect(resolveCommitSubmit("   ", false)).toBeNull();
  });

  it("returns {message, stageAll} with the message trimmed, passing stageAll through as given", () => {
    expect(resolveCommitSubmit("fix bug", true)).toEqual({ message: "fix bug", stageAll: true });
    expect(resolveCommitSubmit("  fix bug  ", false)).toEqual({
      message: "fix bug",
      stageAll: false,
    });
  });
});
