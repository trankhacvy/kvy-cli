import { describe, expect, it, vi } from "vitest";
import { getGitBranches } from "./gitBranches.js";
import { GitExecError } from "./gitExec.js";

const PARAMS = { idempotencyKey: "idem-1", worktree: "/repo" };

describe("getGitBranches", () => {
  it("marks the HEAD branch as current and leaves checkedOutAt/upstream/lastCommitAt unset when their columns are empty", async () => {
    const git = vi.fn(async () => "main\t*\t\t\t1700000000\n");
    const result = await getGitBranches(PARAMS, { git });

    expect(result).toEqual({
      branches: [{ name: "main", isCurrent: true, lastCommitAt: 1_700_000_000 }],
    });
    expect(git).toHaveBeenCalledExactlyOnceWith(
      expect.arrayContaining(["for-each-ref", "refs/heads"]),
      "/repo",
    );
  });

  it("surfaces a branch checked out in another worktree via checkedOutAt", async () => {
    const git = vi.fn(async () => "wf/foo\t\t/repo/.worktrees/wf/foo\torigin/wf/foo\t1700000001\n");
    const result = await getGitBranches(PARAMS, { git });

    expect(result.branches).toEqual([
      {
        name: "wf/foo",
        isCurrent: false,
        checkedOutAt: "/repo/.worktrees/wf/foo",
        upstream: "origin/wf/foo",
        lastCommitAt: 1_700_000_001,
      },
    ]);
  });

  it("omits upstream when the branch has none", async () => {
    const git = vi.fn(async () => "local-only\t\t\t\t1700000002\n");
    const result = await getGitBranches(PARAMS, { git });

    expect(result.branches).toEqual([
      { name: "local-only", isCurrent: false, lastCommitAt: 1_700_000_002 },
    ]);
    expect(result.branches[0]).not.toHaveProperty("upstream");
  });

  it("returns an empty branches array for a repo with no local branches", async () => {
    const git = vi.fn(async () => "");
    const result = await getGitBranches(PARAMS, { git });
    expect(result).toEqual({ branches: [] });
  });

  it("parses multiple branches, most-recently-committed first (per --sort=-committerdate)", async () => {
    const git = vi.fn(
      async () => "main\t*\t\t\t1700000010\nwf/foo\t\t\t\t1700000005\nwf/bar\t\t\t\t1700000000\n",
    );
    const result = await getGitBranches(PARAMS, { git });
    expect(result.branches.map((b) => b.name)).toEqual(["main", "wf/foo", "wf/bar"]);
  });

  it("propagates a git failure as GitExecError", async () => {
    const git = vi.fn(async () => {
      throw new GitExecError("fatal: not a git repository");
    });
    await expect(getGitBranches(PARAMS, { git })).rejects.toThrow(GitExecError);
  });
});
