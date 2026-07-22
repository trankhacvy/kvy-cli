import { describe, expect, it, vi } from "vitest";
import { GitExecError } from "./gitExec.js";
import { handleGitPush } from "./gitPush.js";

const PARAMS = { idempotencyKey: "idem-1", worktree: "/repo" };

function okAuthorizer() {
  return vi.fn(async () => {});
}

describe("handleGitPush", () => {
  it("resolves the current branch and pushes to origin when branch/remote are omitted", async () => {
    const git = vi.fn(async (args: string[]) => (args[0] === "rev-parse" ? "main\n" : ""));

    const result = await handleGitPush(PARAMS, { git, authorizeWorktree: okAuthorizer() });

    expect(result).toEqual({ ok: true, remote: "origin", branch: "main", forced: false });
    expect(git).toHaveBeenCalledWith(["push", "origin", "main"], "/repo");
  });

  it("maps force:true to --force-with-lease, never raw --force", async () => {
    const git = vi.fn(async (args: string[]) => (args[0] === "rev-parse" ? "main\n" : ""));

    const result = await handleGitPush(
      { ...PARAMS, force: true },
      { git, authorizeWorktree: okAuthorizer() },
    );

    expect(result.forced).toBe(true);
    expect(git).toHaveBeenCalledWith(["push", "--force-with-lease", "origin", "main"], "/repo");
    const pushCall = git.mock.calls.find((call) => call[0][0] === "push");
    expect(pushCall?.[0]).not.toContain("--force");
    expect(pushCall?.[0]).not.toEqual(expect.arrayContaining(["--force"]));
  });

  it("adds -u when setUpstream is true", async () => {
    const git = vi.fn(async (args: string[]) => (args[0] === "rev-parse" ? "main\n" : ""));

    await handleGitPush(
      { ...PARAMS, setUpstream: true },
      { git, authorizeWorktree: okAuthorizer() },
    );

    expect(git).toHaveBeenCalledWith(["push", "-u", "origin", "main"], "/repo");
  });

  it("combines force and setUpstream in the documented flag order", async () => {
    const git = vi.fn(async (args: string[]) => (args[0] === "rev-parse" ? "main\n" : ""));

    await handleGitPush(
      { ...PARAMS, force: true, setUpstream: true },
      { git, authorizeWorktree: okAuthorizer() },
    );

    expect(git).toHaveBeenCalledWith(
      ["push", "--force-with-lease", "-u", "origin", "main"],
      "/repo",
    );
  });

  it("uses explicit branch/remote when given, skipping rev-parse", async () => {
    const git = vi.fn(async () => "");

    const result = await handleGitPush(
      { ...PARAMS, branch: "feature/x", remote: "upstream" },
      { git, authorizeWorktree: okAuthorizer() },
    );

    expect(result).toEqual({ ok: true, remote: "upstream", branch: "feature/x", forced: false });
    expect(git).toHaveBeenCalledExactlyOnceWith(["push", "upstream", "feature/x"], "/repo");
  });

  it("rejects a detached HEAD when no explicit branch is given", async () => {
    const git = vi.fn(async (args: string[]) => (args[0] === "rev-parse" ? "HEAD\n" : ""));

    await expect(handleGitPush(PARAMS, { git, authorizeWorktree: okAuthorizer() })).rejects.toThrow(
      /detached/,
    );
    expect(git).not.toHaveBeenCalledWith(expect.arrayContaining(["push"]), "/repo");
  });

  it("rejects an unsafe (leading '-') branch name without calling git push", async () => {
    const git = vi.fn(async () => "");

    await expect(
      handleGitPush(
        { ...PARAMS, branch: "--upload-pack=evil" },
        { git, authorizeWorktree: okAuthorizer() },
      ),
    ).rejects.toThrow(GitExecError);
    expect(git).not.toHaveBeenCalled();
  });

  it("rejects an unsafe remote name without calling git push", async () => {
    const git = vi.fn(async () => "");

    await expect(
      handleGitPush(
        { ...PARAMS, branch: "main", remote: "-x" },
        { git, authorizeWorktree: okAuthorizer() },
      ),
    ).rejects.toThrow(GitExecError);
    expect(git).not.toHaveBeenCalled();
  });

  it("rejects before invoking git when the worktree isn't authorized", async () => {
    const git = vi.fn(async () => "");
    const authorizeWorktree = vi.fn(async () => {
      throw new GitExecError("worktree is not inside a registered workspace: /repo");
    });

    await expect(handleGitPush(PARAMS, { git, authorizeWorktree })).rejects.toThrow(GitExecError);
    expect(git).not.toHaveBeenCalled();
  });

  it("rethrows an arbitrary git push failure (e.g. no credentials configured)", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "push") throw new GitExecError("fatal: could not read Username");
      return "main\n";
    });

    await expect(handleGitPush(PARAMS, { git, authorizeWorktree: okAuthorizer() })).rejects.toThrow(
      "fatal: could not read Username",
    );
  });
});
