import { describe, expect, it, vi } from "vitest";
import { getGitBranches } from "./gitBranches.js";
import { GitExecError } from "./gitExec.js";

const PARAMS = { idempotencyKey: "idem-1", worktree: "/repo" };

/** Every test here exercises the porcelain-parsing logic against a fake `worktree` path that doesn't exist on disk — bypasses the real filesystem check so those tests don't depend on it. */
const skipWorkspaceValidation = async () => {};

/** An args-aware fake `git`: `for-each-ref refs/heads` returns `localOutput`, `remote` returns `remoteNames` (empty by default — no configured remote), `for-each-ref refs/remotes` returns `remoteOutput`. */
function fakeGit(options: { localOutput: string; remoteNames?: string[]; remoteOutput?: string }) {
  const { localOutput, remoteNames = [], remoteOutput = "" } = options;
  return vi.fn(async (args: string[]) => {
    if (args[0] === "remote") return remoteNames.join("\n");
    if (args.includes("refs/remotes")) return remoteOutput;
    return localOutput;
  });
}

describe("getGitBranches", () => {
  it("marks the HEAD branch as current and leaves checkedOutAt/upstream/lastCommitAt unset when their columns are empty", async () => {
    const git = fakeGit({ localOutput: "main\t*\t\t\t1700000000\n" });
    const result = await getGitBranches(PARAMS, {
      git,
      assertWorkspaceValid: skipWorkspaceValidation,
    });

    expect(result).toEqual({
      branches: [{ name: "main", isCurrent: true, lastCommitAt: 1_700_000_000 }],
    });
    expect(git).toHaveBeenCalledWith(
      expect.arrayContaining(["for-each-ref", "refs/heads"]),
      "/repo",
    );
  });

  it("surfaces a branch checked out in another worktree via checkedOutAt", async () => {
    const git = fakeGit({
      localOutput: "wf/foo\t\t/repo/.worktrees/wf/foo\torigin/wf/foo\t1700000001\n",
    });
    const result = await getGitBranches(PARAMS, {
      git,
      assertWorkspaceValid: skipWorkspaceValidation,
    });

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
    const git = fakeGit({ localOutput: "local-only\t\t\t\t1700000002\n" });
    const result = await getGitBranches(PARAMS, {
      git,
      assertWorkspaceValid: skipWorkspaceValidation,
    });

    expect(result.branches).toEqual([
      { name: "local-only", isCurrent: false, lastCommitAt: 1_700_000_002 },
    ]);
    expect(result.branches[0]).not.toHaveProperty("upstream");
  });

  it("returns an empty branches array for a repo with no local branches and no remote", async () => {
    const git = fakeGit({ localOutput: "" });
    const result = await getGitBranches(PARAMS, {
      git,
      assertWorkspaceValid: skipWorkspaceValidation,
    });
    expect(result).toEqual({ branches: [] });
  });

  it("parses multiple branches, most-recently-committed first (per --sort=-committerdate)", async () => {
    const git = fakeGit({
      localOutput: "main\t*\t\t\t1700000010\nwf/foo\t\t\t\t1700000005\nwf/bar\t\t\t\t1700000000\n",
    });
    const result = await getGitBranches(PARAMS, {
      git,
      assertWorkspaceValid: skipWorkspaceValidation,
    });
    expect(result.branches.map((b) => b.name)).toEqual(["main", "wf/foo", "wf/bar"]);
  });

  it("skips refs/remotes entirely when the repo has no configured remote", async () => {
    const git = fakeGit({ localOutput: "main\t*\t\t\t1700000000\n" });
    await getGitBranches(PARAMS, { git, assertWorkspaceValid: skipWorkspaceValidation });

    expect(git).not.toHaveBeenCalledWith(expect.arrayContaining(["refs/remotes"]), "/repo");
  });

  it("includes remote-tracking branches marked remote:true when a remote is configured", async () => {
    const git = fakeGit({
      localOutput: "main\t*\t\t\t1700000010\n",
      remoteNames: ["origin"],
      remoteOutput: "origin/HEAD\t\t\t\t1700000010\norigin/main\t\t\t\t1700000010\n",
    });
    const result = await getGitBranches(PARAMS, {
      git,
      assertWorkspaceValid: skipWorkspaceValidation,
    });

    expect(result.branches).toEqual([
      { name: "main", isCurrent: true, lastCommitAt: 1_700_000_010 },
      { name: "origin/main", isCurrent: false, lastCommitAt: 1_700_000_010, remote: true },
    ]);
  });

  it("propagates a git failure as GitExecError", async () => {
    const git = vi.fn(async () => {
      throw new GitExecError("fatal: not a git repository");
    });
    await expect(
      getGitBranches(PARAMS, { git, assertWorkspaceValid: skipWorkspaceValidation }),
    ).rejects.toThrow(GitExecError);
  });

  it("propagates a WorkspaceValidationError from assertWorkspaceValid without ever calling git", async () => {
    const git = vi.fn(async () => "");
    const assertWorkspaceValid = vi.fn(async () => {
      throw new Error("workspace directory not found: /repo");
    });
    await expect(getGitBranches(PARAMS, { git, assertWorkspaceValid })).rejects.toThrow(
      "workspace directory not found",
    );
    expect(git).not.toHaveBeenCalled();
  });
});
