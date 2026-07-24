import { describe, expect, it, vi } from "vitest";
import type { MachineRpcClient } from "@/sync/machineRpc";
import { machineRpcToGitDiffActions } from "../live-actions";

function fakeRpc(call: MachineRpcClient["call"]): MachineRpcClient {
  return { call };
}

describe("machineRpcToGitDiffActions", () => {
  it("fetchStatus calls git.status with the given worktree and returns the result as-is", async () => {
    const call = vi.fn(async () => ({
      branch: "main",
      ahead: 1,
      behind: 0,
      files: [{ path: "src/a.ts", status: "modified" }],
    }));
    const actions = machineRpcToGitDiffActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.fetchStatus("/repo");

    expect(result).toEqual({
      branch: "main",
      ahead: 1,
      behind: 0,
      files: [{ path: "src/a.ts", status: "modified" }],
    });
    expect(call).toHaveBeenCalledWith("git.status", expect.objectContaining({ worktree: "/repo" }));
  });

  it("fetchDiff calls git.diff with worktree/path/baseRef and maps the result", async () => {
    const call = vi.fn(async () => ({ inline: "diff --git a/x b/x", truncated: false }));
    const actions = machineRpcToGitDiffActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.fetchDiff("/repo", { path: "src/a.ts", baseRef: "main" });

    expect(result).toEqual({ inline: "diff --git a/x b/x", truncated: false });
    expect(call).toHaveBeenCalledWith(
      "git.diff",
      expect.objectContaining({ worktree: "/repo", path: "src/a.ts", baseRef: "main" }),
    );
  });

  it("fetchDiff omits path/baseRef when not given", async () => {
    const call = vi.fn(async () => ({ inline: "diff", truncated: false }));
    const actions = machineRpcToGitDiffActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    await actions.fetchDiff("/repo");

    expect(call).toHaveBeenCalledWith(
      "git.diff",
      expect.objectContaining({ worktree: "/repo", path: undefined, baseRef: undefined }),
    );
  });

  it("fetchDiff surfaces truncated: true diffs unchanged", async () => {
    const call = vi.fn(async () => ({ inline: "partial diff", truncated: true }));
    const actions = machineRpcToGitDiffActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.fetchDiff("/repo");
    expect(result).toEqual({ inline: "partial diff", truncated: true });
  });

  it("commit defaults stageAll:true when the caller omits it", async () => {
    const call = vi.fn(async () => ({ committed: true, commitSha: "abc1234" }));
    const actions = machineRpcToGitDiffActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.commit("/repo", "fix bug");

    expect(result).toEqual({ committed: true, commitSha: "abc1234" });
    expect(call).toHaveBeenCalledWith(
      "git.commit",
      expect.objectContaining({ worktree: "/repo", message: "fix bug", stageAll: true }),
    );
  });

  it("commit passes stageAll:false through when the caller explicitly opts out", async () => {
    const call = vi.fn(async () => ({ committed: true, commitSha: "def5678" }));
    const actions = machineRpcToGitDiffActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    await actions.commit("/repo", "fix bug", { stageAll: false });

    expect(call).toHaveBeenCalledWith("git.commit", expect.objectContaining({ stageAll: false }));
  });

  it("push({force:true}) sends force:true on the git.push wire call", async () => {
    const call = vi.fn(async () => ({
      ok: true as const,
      remote: "origin",
      branch: "main",
      forced: true,
    }));
    const actions = machineRpcToGitDiffActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.push("/repo", { force: true });

    expect(result).toEqual({ remote: "origin", branch: "main", forced: true });
    expect(call).toHaveBeenCalledWith(
      "git.push",
      expect.objectContaining({ worktree: "/repo", force: true }),
    );
  });

  it("push with no options omits force/setUpstream", async () => {
    const call = vi.fn(async () => ({
      ok: true as const,
      remote: "origin",
      branch: "main",
      forced: false,
    }));
    const actions = machineRpcToGitDiffActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    await actions.push("/repo");

    expect(call).toHaveBeenCalledWith(
      "git.push",
      expect.objectContaining({ worktree: "/repo", force: undefined, setUpstream: undefined }),
    );
  });

  it("renameBranch calls git.renameBranch and maps the result", async () => {
    const call = vi.fn(async () => ({ ok: true as const, branch: "renamed", hadUpstream: true }));
    const actions = machineRpcToGitDiffActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.renameBranch("/repo", "renamed");

    expect(result).toEqual({ branch: "renamed", hadUpstream: true });
    expect(call).toHaveBeenCalledWith(
      "git.renameBranch",
      expect.objectContaining({ worktree: "/repo", to: "renamed" }),
    );
  });

  it("listBranches calls git.branches and returns result.branches", async () => {
    const call = vi.fn(async () => ({
      branches: [
        { name: "main", isCurrent: true },
        { name: "wf/foo", isCurrent: false },
      ],
    }));
    const actions = machineRpcToGitDiffActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.listBranches("/repo");

    expect(result).toEqual([
      { name: "main", isCurrent: true },
      { name: "wf/foo", isCurrent: false },
    ]);
    expect(call).toHaveBeenCalledWith(
      "git.branches",
      expect.objectContaining({ worktree: "/repo" }),
    );
  });

  it("unregisterWorkspace calls workspace.unregister with the worktree as directory", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const actions = machineRpcToGitDiffActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.unregisterWorkspace("/repo");

    expect(result).toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith(
      "workspace.unregister",
      expect.objectContaining({ directory: "/repo" }),
    );
  });
});
