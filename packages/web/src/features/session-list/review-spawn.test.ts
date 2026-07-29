import { describe, expect, it } from "vitest";
import { buildReviewSpawnRequest } from "./review-spawn";

describe("buildReviewSpawnRequest", () => {
  it("derives repoRoot via parentWorktreePath, not the coding session's own worktree directory", () => {
    const request = buildReviewSpawnRequest(
      "/repo/.worktrees/wf/coding-session",
      "wf/coding-session",
      () => 1234,
    );
    expect(request?.directory).toBe("/repo");
  });

  it("names the branch review/<codingBranch>-<now> and creates a fresh worktree from it", () => {
    const request = buildReviewSpawnRequest("/repo/.worktrees/wf/x", "wf/x", () => 1234);
    expect(request?.branch).toEqual({
      name: "review/wf/x-1234",
      createWorktree: true,
      from: "wf/x",
    });
  });

  it("starts in plan permission mode", () => {
    const request = buildReviewSpawnRequest("/repo/.worktrees/wf/x", "wf/x", () => 1234);
    expect(request?.permissionMode).toBe("plan");
  });

  it("uses the claude-code provider", () => {
    const request = buildReviewSpawnRequest("/repo/.worktrees/wf/x", "wf/x", () => 1234);
    expect(request?.provider).toBe("claude-code");
  });

  it("returns null when workspacePath isn't a worktree path (defensive — the caller gates on looksLikeWorktreePath first)", () => {
    expect(buildReviewSpawnRequest("/repo", "main", () => 1234)).toBe(null);
  });

  it("re-parents onto the outermost repo root for a nested worktree-of-worktree", () => {
    const request = buildReviewSpawnRequest("/repo/.worktrees/a/.worktrees/b", "b", () => 1234);
    expect(request?.directory).toBe("/repo");
  });
});
