import { describe, expect, it, vi } from "vitest";
import { handleGitCommit } from "./gitCommit.js";
import { GitExecError } from "./gitExec.js";

const PARAMS = { idempotencyKey: "idem-1", worktree: "/repo", message: "fix bug" };

function okAuthorizer() {
  return vi.fn(async () => {});
}

describe("handleGitCommit", () => {
  it("commits tracked changes only (git commit -am) when stageAll is omitted", async () => {
    const git = vi.fn(async (args: string[]) => (args[0] === "rev-parse" ? "abc1234\n" : ""));
    const authorizeWorktree = okAuthorizer();

    const result = await handleGitCommit(PARAMS, { git, authorizeWorktree });

    expect(result).toEqual({ committed: true, commitSha: "abc1234" });
    expect(git).toHaveBeenCalledWith(["commit", "-am", "fix bug"], "/repo");
    expect(git).not.toHaveBeenCalledWith(["add", "-A"], "/repo");
    expect(authorizeWorktree).toHaveBeenCalledExactlyOnceWith("/repo");
  });

  it("stages everything first (git add -A) and commits with -m when stageAll is true", async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      return args[0] === "rev-parse" ? "def5678\n" : "";
    });

    const result = await handleGitCommit(
      { ...PARAMS, stageAll: true },
      { git, authorizeWorktree: okAuthorizer() },
    );

    expect(result).toEqual({ committed: true, commitSha: "def5678" });
    expect(calls[0]).toEqual(["add", "-A"]);
    expect(calls[1]).toEqual(["commit", "-m", "fix bug"]);
  });

  it("passes the message as its own argv element — no shell quoting hazard", async () => {
    const git = vi.fn(async (args: string[]) => (args[0] === "rev-parse" ? "sha\n" : ""));
    await handleGitCommit(
      { ...PARAMS, message: "fix `rm -rf /` in docs" },
      { git, authorizeWorktree: okAuthorizer() },
    );
    expect(git).toHaveBeenCalledWith(["commit", "-am", "fix `rm -rf /` in docs"], "/repo");
  });

  it("maps a clean working tree to nothingToCommit:true rather than throwing", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "commit") throw new GitExecError("nothing to commit, working tree clean");
      return "";
    });

    const result = await handleGitCommit(PARAMS, { git, authorizeWorktree: okAuthorizer() });
    expect(result).toEqual({ committed: false, nothingToCommit: true });
    // No rev-parse call after a nothing-to-commit outcome — there's no new commit to report.
    expect(git).not.toHaveBeenCalledWith(["rev-parse", "HEAD"], "/repo");
  });

  it("rejects before invoking git when the worktree isn't authorized", async () => {
    const git = vi.fn(async () => "");
    const authorizeWorktree = vi.fn(async () => {
      throw new GitExecError("worktree is not inside a registered workspace: /repo");
    });

    await expect(handleGitCommit(PARAMS, { git, authorizeWorktree })).rejects.toThrow(GitExecError);
    expect(git).not.toHaveBeenCalled();
  });

  it("rethrows any other GitExecError (throw-through, no silent fallback)", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "commit") throw new GitExecError("fatal: unable to write commit object");
      return "";
    });

    await expect(
      handleGitCommit(PARAMS, { git, authorizeWorktree: okAuthorizer() }),
    ).rejects.toThrow("fatal: unable to write commit object");
  });
});
