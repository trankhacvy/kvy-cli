import { describe, expect, it, vi } from "vitest";
import { GitExecError } from "./gitExec.js";
import { handleGitInit } from "./gitInit.js";
import { GitWorktreeError } from "./gitWorktree.js";

const PARAMS = { idempotencyKey: "idem-1", worktree: "/repo" };

function okAuthorizer() {
  return vi.fn(async () => {});
}

describe("handleGitInit", () => {
  /** Fakes a fresh, un-repo'd directory before `init` and a real one after — `--show-toplevel` fails until `init` has run (`calls` tracks whether it has), then `--abbrev-ref HEAD` resolves `branch`. */
  function freshDirGit(branch: string) {
    let initialized = false;
    const calls: string[] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "init") {
        initialized = true;
        return "";
      }
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        if (!initialized) throw new GitExecError("fatal: not a git repository");
        return `/repo\n`;
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return initialized ? `${branch}\n` : "HEAD\n";
      }
      return "";
    });
    return { git, calls };
  }

  it("runs git init and returns the new branch, authorizing before any git call", async () => {
    const { git, calls } = freshDirGit("main");
    const authorizeWorktree = vi.fn(async () => {
      calls.push("authorize");
    });

    const result = await handleGitInit(PARAMS, {
      git,
      authorizeWorktree,
      hasGitDir: async () => false,
    });

    expect(result).toEqual({ state: "initialized", branch: "main" });
    expect(git).toHaveBeenCalledWith(["init"], "/repo");
    expect(calls[0]).toBe("authorize");
    expect(calls.indexOf("authorize")).toBeLessThan(calls.indexOf("init"));
  });

  it("passes --initial-branch=<name> when initialBranch is given", async () => {
    const { git } = freshDirGit("trunk");

    const result = await handleGitInit(
      { ...PARAMS, initialBranch: "trunk" },
      { git, authorizeWorktree: okAuthorizer(), hasGitDir: async () => false },
    );

    expect(result).toEqual({ state: "initialized", branch: "trunk" });
    expect(git).toHaveBeenCalledWith(["init", "--initial-branch=trunk"], "/repo");
  });

  it("rejects an unsafe initialBranch and never calls git", async () => {
    const git = vi.fn(async () => "");

    await expect(
      handleGitInit(
        { ...PARAMS, initialBranch: "--upload-pack=evil" },
        { git, authorizeWorktree: okAuthorizer(), hasGitDir: async () => false },
      ),
    ).rejects.toThrow(GitWorktreeError);
    expect(git).not.toHaveBeenCalled();
  });

  it("resolves already-repo without calling git init when .git already exists", async () => {
    const git = vi.fn(async (args: string[]) => (args[0] === "rev-parse" ? "main\n" : ""));

    const result = await handleGitInit(PARAMS, {
      git,
      authorizeWorktree: okAuthorizer(),
      hasGitDir: async () => true,
    });

    expect(result).toEqual({ state: "already-repo", branch: "main" });
    expect(git).not.toHaveBeenCalledWith(["init"], "/repo");
  });

  it("resolves inside-existing-repo (with existingRoot) instead of nesting a repo, without calling git init", async () => {
    const git = vi.fn(async (args: string[]) =>
      args[0] === "rev-parse" && args[1] === "--show-toplevel" ? "/repo\n" : "",
    );

    const result = await handleGitInit(
      { idempotencyKey: "idem-1", worktree: "/repo/subdir" },
      { git, authorizeWorktree: okAuthorizer(), hasGitDir: async () => false },
    );

    expect(result).toEqual({ state: "inside-existing-repo", existingRoot: "/repo" });
    expect(git).not.toHaveBeenCalledWith(["init"], "/repo/subdir");
  });

  it("rejects before invoking git when the worktree isn't authorized (workspace-missing guarantee)", async () => {
    const git = vi.fn(async () => "");
    const authorizeWorktree = vi.fn(async () => {
      throw new GitExecError("worktree is not inside a registered workspace: /repo");
    });

    await expect(
      handleGitInit(PARAMS, { git, authorizeWorktree, hasGitDir: async () => false }),
    ).rejects.toThrow(GitExecError);
    expect(git).not.toHaveBeenCalled();
  });

  it("rethrows a genuine git init failure", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "init") throw new GitExecError("fatal: permission denied");
      return "";
    });

    await expect(
      handleGitInit(PARAMS, {
        git,
        authorizeWorktree: okAuthorizer(),
        hasGitDir: async () => false,
      }),
    ).rejects.toThrow("fatal: permission denied");
  });
});
