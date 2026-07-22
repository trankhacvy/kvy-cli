import { describe, expect, it, vi } from "vitest";
import { type MachineRpcClient, MachineRpcError } from "@/sync/machineRpc";
import { machineRpcToGithubChecksActions } from "../live-actions";
import { DaemonUnsupportedError } from "../types";

function fakeRpc(call: MachineRpcClient["call"]): MachineRpcClient {
  return { call };
}

describe("machineRpcToGithubChecksActions", () => {
  it("fetchChecks calls github.checks with the given worktree and returns the result as-is", async () => {
    const call = vi.fn(async () => ({ state: "not-pushed", branch: "feature/x" }));
    const actions = machineRpcToGithubChecksActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.fetchChecks("/repo");

    expect(result).toEqual({ state: "not-pushed", branch: "feature/x" });
    expect(call).toHaveBeenCalledWith(
      "github.checks",
      expect.objectContaining({ worktree: "/repo" }),
    );
  });

  it("mints a fresh idempotencyKey per call", async () => {
    const call = vi.fn(
      async (_method: string, _params: { idempotencyKey: string; worktree: string }) => ({
        state: "ok" as const,
      }),
    );
    const actions = machineRpcToGithubChecksActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    await actions.fetchChecks("/repo");
    await actions.fetchChecks("/repo");

    const keys = call.mock.calls.map(([, params]) => params.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("maps an 'unknown-method' MachineRpcError to a typed DaemonUnsupportedError", async () => {
    const call = vi.fn(async () => {
      throw new MachineRpcError("unknown-method", "rpc-failed");
    });
    const actions = machineRpcToGithubChecksActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    await expect(actions.fetchChecks("/repo")).rejects.toBeInstanceOf(DaemonUnsupportedError);
  });

  it("re-throws every other failure unchanged", async () => {
    const call = vi.fn(async () => {
      throw new MachineRpcError("decrypt failed", "decrypt-failed");
    });
    const actions = machineRpcToGithubChecksActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    await expect(actions.fetchChecks("/repo")).rejects.toMatchObject({ message: "decrypt failed" });
  });
});
