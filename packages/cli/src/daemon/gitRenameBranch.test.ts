import { describe, expect, it, vi } from "vitest";
import { GitExecError } from "./gitExec.js";
import { handleGitRenameBranch } from "./gitRenameBranch.js";
import { GitWorktreeError } from "./gitWorktree.js";

const PARAMS = { idempotencyKey: "idem-1", worktree: "/repo", to: "renamed" };

function okAuthorizer() {
  return vi.fn(async () => {});
}

describe("handleGitRenameBranch", () => {
  it("renames the current branch (from omitted) and reports hadUpstream:true", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") return "main\n";
      if (args[0] === "for-each-ref") return "origin/main\n";
      return "";
    });

    const result = await handleGitRenameBranch(PARAMS, { git, authorizeWorktree: okAuthorizer() });

    expect(result).toEqual({ ok: true, branch: "renamed", hadUpstream: true });
    expect(git).toHaveBeenCalledWith(["branch", "-m", "renamed"], "/repo");
    expect(git).toHaveBeenCalledWith(
      ["for-each-ref", "--format=%(upstream:short)", "refs/heads/main"],
      "/repo",
    );
  });

  it("reports hadUpstream:false when the source branch has no upstream", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") return "main\n";
      if (args[0] === "for-each-ref") return "\n";
      return "";
    });

    const result = await handleGitRenameBranch(PARAMS, { git, authorizeWorktree: okAuthorizer() });
    expect(result.hadUpstream).toBe(false);
  });

  it("renames an explicit `from` branch without resolving the current branch", async () => {
    const git = vi.fn(async (args: string[]) => (args[0] === "for-each-ref" ? "\n" : ""));

    const result = await handleGitRenameBranch(
      { ...PARAMS, from: "old-name" },
      { git, authorizeWorktree: okAuthorizer() },
    );

    expect(result).toEqual({ ok: true, branch: "renamed", hadUpstream: false });
    expect(git).toHaveBeenCalledWith(["branch", "-m", "old-name", "renamed"], "/repo");
    expect(git).not.toHaveBeenCalledWith(["rev-parse", "--abbrev-ref", "HEAD"], "/repo");
  });

  it("rejects an unsafe `to` branch name without calling git", async () => {
    const git = vi.fn(async () => "");

    await expect(
      handleGitRenameBranch({ ...PARAMS, to: "-x" }, { git, authorizeWorktree: okAuthorizer() }),
    ).rejects.toThrow(GitWorktreeError);
    expect(git).not.toHaveBeenCalled();
  });

  it("rejects an unsafe `from` branch name without calling git", async () => {
    const git = vi.fn(async () => "");

    await expect(
      handleGitRenameBranch(
        { ...PARAMS, from: "../escape" },
        { git, authorizeWorktree: okAuthorizer() },
      ),
    ).rejects.toThrow(GitWorktreeError);
    expect(git).not.toHaveBeenCalled();
  });

  it("rejects before invoking git when the worktree isn't authorized", async () => {
    const git = vi.fn(async () => "");
    const authorizeWorktree = vi.fn(async () => {
      throw new GitExecError("worktree is not inside a registered workspace: /repo");
    });

    await expect(handleGitRenameBranch(PARAMS, { git, authorizeWorktree })).rejects.toThrow(
      GitExecError,
    );
    expect(git).not.toHaveBeenCalled();
  });

  it("rethrows an arbitrary git failure (e.g. branch already exists)", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") return "main\n";
      if (args[0] === "for-each-ref") return "\n";
      if (args[0] === "branch")
        throw new GitExecError("fatal: a branch named 'renamed' already exists");
      return "";
    });

    await expect(
      handleGitRenameBranch(PARAMS, { git, authorizeWorktree: okAuthorizer() }),
    ).rejects.toThrow("already exists");
  });
});
