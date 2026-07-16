import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBranchWorkspace, type GitExec, GitWorktreeError } from "./gitWorktree.js";

describe("ensureBranchWorkspace", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "falcon-git-worktree-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("checks out a new branch in place when createWorktree is false and the branch is new", async () => {
    const git = vi.fn<GitExec>(async (args: string[]) => {
      if (args[0] === "show-ref") throw new Error("not found");
      return "";
    });

    const result = await ensureBranchWorkspace(
      { repoDirectory: root, branch: { name: "feature/x", createWorktree: false } },
      { git },
    );

    expect(result).toEqual({ directory: root });
    expect(git).toHaveBeenCalledWith(
      ["show-ref", "--verify", "--quiet", "refs/heads/feature/x"],
      root,
    );
    expect(git).toHaveBeenCalledWith(["checkout", "-b", "feature/x"], root);
  });

  it("checks out an existing branch (no -b) when createWorktree is false and the branch already exists", async () => {
    const git = vi.fn<GitExec>(async () => "");

    await ensureBranchWorkspace(
      { repoDirectory: root, branch: { name: "main", createWorktree: false } },
      { git },
    );

    expect(git).toHaveBeenCalledWith(["checkout", "main"], root);
  });

  it("creates a new worktree at <repo>/.worktrees/<branch> with -b for a new branch", async () => {
    const git = vi.fn<GitExec>(async (args: string[]) => {
      if (args[0] === "show-ref") throw new Error("not found");
      return "";
    });

    const result = await ensureBranchWorkspace(
      { repoDirectory: root, branch: { name: "task-1", createWorktree: true } },
      { git },
    );

    const expectedDir = path.join(root, ".worktrees", "task-1");
    expect(result).toEqual({ directory: expectedDir });
    expect(git).toHaveBeenCalledWith(["worktree", "add", expectedDir, "-b", "task-1"], root);
  });

  it("adds a worktree without -b when the branch already exists", async () => {
    const git = vi.fn<GitExec>(async () => "");

    const result = await ensureBranchWorkspace(
      { repoDirectory: root, branch: { name: "existing-branch", createWorktree: true } },
      { git },
    );

    const expectedDir = path.join(root, ".worktrees", "existing-branch");
    expect(git).toHaveBeenCalledWith(["worktree", "add", expectedDir, "existing-branch"], root);
    expect(result).toEqual({ directory: expectedDir });
  });

  it("is idempotent: reuses an existing worktree directory without calling git again", async () => {
    const worktreeDir = path.join(root, ".worktrees", "task-1");
    await mkdir(worktreeDir, { recursive: true });
    const git = vi.fn<GitExec>(async () => "");

    const result = await ensureBranchWorkspace(
      { repoDirectory: root, branch: { name: "task-1", createWorktree: true } },
      { git },
    );

    expect(result).toEqual({ directory: worktreeDir });
    expect(git).not.toHaveBeenCalled();
  });

  it("rejects a branch name that could path-escape .worktrees/", async () => {
    const git = vi.fn<GitExec>(async () => "");
    await expect(
      ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "../../etc", createWorktree: true } },
        { git },
      ),
    ).rejects.toThrow(GitWorktreeError);
    expect(git).not.toHaveBeenCalled();
  });

  it("propagates a git failure as GitWorktreeError", async () => {
    const git = vi.fn<GitExec>(async () => {
      throw new Error("fatal: not a git repository");
    });
    await expect(
      ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "task-1", createWorktree: false } },
        { git },
      ),
    ).rejects.toThrow(/not a git repository/);
  });
});
