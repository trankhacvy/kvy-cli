import { describe, expect, it, vi } from "vitest";
import { GitExecError } from "./gitExec.js";
import { getGitRemotes } from "./gitRemotes.js";

const PARAMS = { idempotencyKey: "idem-1", worktree: "/repo" };

/** Every test here exercises the porcelain-parsing logic against a fake `worktree` path that doesn't exist on disk — bypasses the real filesystem check so those tests don't depend on it. */
const skipWorkspaceValidation = async () => {};

describe("getGitRemotes", () => {
  it("keeps only the (fetch) row for each remote", async () => {
    const git = vi.fn(
      async () =>
        "origin\thttps://github.com/acme/falcon.git (fetch)\n" +
        "origin\thttps://github.com/acme/falcon.git (push)\n",
    );
    const result = await getGitRemotes(PARAMS, {
      git,
      assertWorkspaceValid: skipWorkspaceValidation,
    });

    expect(result).toEqual({
      remotes: [{ name: "origin", url: "https://github.com/acme/falcon.git" }],
    });
    expect(git).toHaveBeenCalledExactlyOnceWith(["remote", "-v"], "/repo");
  });

  it("parses multiple remotes", async () => {
    const git = vi.fn(
      async () =>
        "origin\thttps://github.com/acme/falcon.git (fetch)\n" +
        "origin\thttps://github.com/acme/falcon.git (push)\n" +
        "upstream\thttps://github.com/upstream/falcon.git (fetch)\n" +
        "upstream\thttps://github.com/upstream/falcon.git (push)\n",
    );
    const result = await getGitRemotes(PARAMS, {
      git,
      assertWorkspaceValid: skipWorkspaceValidation,
    });

    expect(result.remotes).toEqual([
      { name: "origin", url: "https://github.com/acme/falcon.git" },
      { name: "upstream", url: "https://github.com/upstream/falcon.git" },
    ]);
  });

  it("returns an empty remotes array for a repo with no remotes", async () => {
    const git = vi.fn(async () => "");
    const result = await getGitRemotes(PARAMS, {
      git,
      assertWorkspaceValid: skipWorkspaceValidation,
    });
    expect(result).toEqual({ remotes: [] });
  });

  it("propagates a git failure as GitExecError", async () => {
    const git = vi.fn(async () => {
      throw new GitExecError("fatal: not a git repository");
    });
    await expect(
      getGitRemotes(PARAMS, { git, assertWorkspaceValid: skipWorkspaceValidation }),
    ).rejects.toThrow(GitExecError);
  });

  it("propagates a WorkspaceValidationError from assertWorkspaceValid without ever calling git", async () => {
    const git = vi.fn(async () => "");
    const assertWorkspaceValid = vi.fn(async () => {
      throw new Error("workspace directory not found: /repo");
    });
    await expect(getGitRemotes(PARAMS, { git, assertWorkspaceValid })).rejects.toThrow(
      "workspace directory not found",
    );
    expect(git).not.toHaveBeenCalled();
  });
});
