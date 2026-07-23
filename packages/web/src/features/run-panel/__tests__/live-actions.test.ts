import { describe, expect, it, vi } from "vitest";
import type { MachineRpcClient } from "@/sync/machineRpc";
import { machineRpcToRunPanelActions } from "../live-actions";

function fakeRpc(call: MachineRpcClient["call"]): MachineRpcClient {
  return { call };
}

describe("machineRpcToRunPanelActions", () => {
  it("getConfig calls workspace.getConfig with the given worktree and returns the result as-is", async () => {
    const call = vi.fn(async () => ({
      baseRef: "main",
      remote: "origin",
      setupScript: "npm install",
      runScript: "npm run dev",
    }));
    const actions = machineRpcToRunPanelActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.getConfig("/repo");

    expect(result).toEqual({
      baseRef: "main",
      remote: "origin",
      setupScript: "npm install",
      runScript: "npm run dev",
    });
    expect(call).toHaveBeenCalledWith(
      "workspace.getConfig",
      expect.objectContaining({ worktree: "/repo" }),
    );
  });

  it("start calls run.start with a fresh idempotencyKey and returns the result", async () => {
    const call = vi.fn(async () => ({ started: true, method: "tmux", pid: 555 }));
    const actions = machineRpcToRunPanelActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.start("/repo");

    expect(result).toEqual({ started: true, method: "tmux", pid: 555 });
    expect(call).toHaveBeenCalledWith(
      "run.start",
      expect.objectContaining({ worktree: "/repo", idempotencyKey: expect.any(String) }),
    );
  });

  it("two start() calls mint two different idempotencyKeys", async () => {
    const seenKeys: string[] = [];
    const call: MachineRpcClient["call"] = (async (
      _method: string,
      params: { idempotencyKey: string },
    ) => {
      seenKeys.push(params.idempotencyKey);
      return { started: true };
    }) as unknown as MachineRpcClient["call"];
    const actions = machineRpcToRunPanelActions(fakeRpc(call));

    await actions.start("/repo");
    await actions.start("/repo");

    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toEqual(expect.any(String));
    expect(seenKeys[0]).not.toBe(seenKeys[1]);
  });

  it("stop calls run.stop and returns the result", async () => {
    const call = vi.fn(async () => ({ stopped: true, wasRunning: true }));
    const actions = machineRpcToRunPanelActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.stop("/repo");

    expect(result).toEqual({ stopped: true, wasRunning: true });
    expect(call).toHaveBeenCalledWith("run.stop", expect.objectContaining({ worktree: "/repo" }));
  });

  it("status calls run.status and returns the result", async () => {
    const call = vi.fn(async () => ({
      run: { state: "running", pid: 1, method: "tmux", startedAt: 1 },
      setup: { state: "not-run" },
    }));
    const actions = machineRpcToRunPanelActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.status("/repo");

    expect(result).toEqual({
      run: { state: "running", pid: 1, method: "tmux", startedAt: 1 },
      setup: { state: "not-run" },
    });
    expect(call).toHaveBeenCalledWith("run.status", expect.objectContaining({ worktree: "/repo" }));
  });

  it("setup calls run.setup and returns the result", async () => {
    const call = vi.fn(async () => ({ started: true }));
    const actions = machineRpcToRunPanelActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.setup("/repo");

    expect(result).toEqual({ started: true });
    expect(call).toHaveBeenCalledWith("run.setup", expect.objectContaining({ worktree: "/repo" }));
  });
});
