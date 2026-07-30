import { describe, expect, it, vi } from "vitest";
import { GitExecError } from "./gitExec.js";
import { handleGitSetRemote } from "./gitSetRemote.js";

const PARAMS = { idempotencyKey: "idem-1", worktree: "/repo", url: "git@github.com:a/b.git" };

function okAuthorizer() {
  return vi.fn(async () => {});
}

describe("handleGitSetRemote", () => {
  it("adds a new remote named origin by default when none exists", async () => {
    const git = vi.fn(async (args: string[]) =>
      args[0] === "remote" && args.length === 1 ? "" : "",
    );

    const result = await handleGitSetRemote(PARAMS, { git, authorizeWorktree: okAuthorizer() });

    expect(result).toEqual({
      ok: true,
      name: "origin",
      url: "git@github.com:a/b.git",
      created: true,
    });
    expect(git).toHaveBeenCalledWith(
      ["remote", "add", "origin", "git@github.com:a/b.git"],
      "/repo",
    );
  });

  it("updates the URL in place (set-url) when the remote name already exists", async () => {
    const git = vi.fn(async (args: string[]) =>
      args[0] === "remote" && args.length === 1 ? "origin\nupstream" : "",
    );

    const result = await handleGitSetRemote(PARAMS, { git, authorizeWorktree: okAuthorizer() });

    expect(result).toEqual({
      ok: true,
      name: "origin",
      url: "git@github.com:a/b.git",
      created: false,
    });
    expect(git).toHaveBeenCalledWith(
      ["remote", "set-url", "origin", "git@github.com:a/b.git"],
      "/repo",
    );
    expect(git).not.toHaveBeenCalledWith(
      ["remote", "add", "origin", "git@github.com:a/b.git"],
      "/repo",
    );
  });

  it("honours an explicit name other than origin", async () => {
    const git = vi.fn(async (args: string[]) =>
      args[0] === "remote" && args.length === 1 ? "" : "",
    );

    const result = await handleGitSetRemote(
      { ...PARAMS, name: "upstream" },
      { git, authorizeWorktree: okAuthorizer() },
    );

    expect(result.name).toBe("upstream");
    expect(git).toHaveBeenCalledWith(
      ["remote", "add", "upstream", "git@github.com:a/b.git"],
      "/repo",
    );
  });

  it("rejects an unsafe url and never calls git past the existence probe", async () => {
    const git = vi.fn(async (args: string[]) =>
      args[0] === "remote" && args.length === 1 ? "" : "",
    );

    await expect(
      handleGitSetRemote(
        { ...PARAMS, url: "--upload-pack=touch /tmp/pwn" },
        { git, authorizeWorktree: okAuthorizer() },
      ),
    ).rejects.toThrow(GitExecError);
    expect(git).not.toHaveBeenCalled();
  });

  it("rejects an unsafe name and never calls git past the existence probe", async () => {
    const git = vi.fn(async () => "");

    await expect(
      handleGitSetRemote({ ...PARAMS, name: "-x" }, { git, authorizeWorktree: okAuthorizer() }),
    ).rejects.toThrow(GitExecError);
    expect(git).not.toHaveBeenCalled();
  });

  it("rejects before invoking git when the worktree isn't authorized", async () => {
    const git = vi.fn(async () => "");
    const authorizeWorktree = vi.fn(async () => {
      throw new GitExecError("worktree is not inside a registered workspace: /repo");
    });

    await expect(handleGitSetRemote(PARAMS, { git, authorizeWorktree })).rejects.toThrow(
      GitExecError,
    );
    expect(git).not.toHaveBeenCalled();
  });
});
