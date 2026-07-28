import { describe, expect, it } from "vitest";
import { looksLikeWorktreePath } from "./worktree-path";

describe("looksLikeWorktreePath", () => {
  it("is true for a .worktrees/<branch> path", () => {
    expect(looksLikeWorktreePath("/repo/.worktrees/wf/20260722-a3f9")).toBe(true);
  });

  it("is true for a single-segment branch name under .worktrees", () => {
    expect(looksLikeWorktreePath("/repo/.worktrees/my-feature")).toBe(true);
  });

  it("is false for a plain repo root", () => {
    expect(looksLikeWorktreePath("/repo")).toBe(false);
  });

  it("is false for a directory that merely contains 'worktrees' without the leading dot", () => {
    expect(looksLikeWorktreePath("/repo/worktrees/foo")).toBe(false);
  });

  it("is false for null (no resolvable workspaceId)", () => {
    expect(looksLikeWorktreePath(null)).toBe(false);
  });

  it("handles a backslash-separated path the same way (defensive, even though this codebase is POSIX-only today)", () => {
    expect(looksLikeWorktreePath("C:\\repo\\.worktrees\\wf\\foo")).toBe(true);
  });
});
