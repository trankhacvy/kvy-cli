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
});
