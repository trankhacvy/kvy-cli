import { describe, expect, it, vi } from "vitest";
import type { MachineRpcClient } from "@/sync/machineRpc";
import { machineRpcToMachineSettingsActions } from "../live-actions";

function fakeRpc(call: MachineRpcClient["call"]): MachineRpcClient {
  return { call };
}

describe("machineRpcToMachineSettingsActions", () => {
  it("fetchSleepInhibit calls sleepInhibit.get and returns the result as-is", async () => {
    const call = vi.fn(async () => ({
      supported: true,
      platform: "darwin",
      mode: "always" as const,
      active: true,
    }));
    const actions = machineRpcToMachineSettingsActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.fetchSleepInhibit();

    expect(result).toEqual({ supported: true, platform: "darwin", mode: "always", active: true });
    expect(call).toHaveBeenCalledWith(
      "sleepInhibit.get",
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it("setSleepInhibit calls sleepInhibit.set with the given mode and returns the post-apply state", async () => {
    const call = vi.fn(async (_method: string, params: { mode: string }) => ({
      supported: true,
      platform: "darwin",
      mode: params.mode,
      active: params.mode !== "off",
    }));
    const actions = machineRpcToMachineSettingsActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.setSleepInhibit("onPower");

    expect(result).toEqual({
      supported: true,
      platform: "darwin",
      mode: "onPower",
      active: true,
    });
    expect(call).toHaveBeenCalledWith(
      "sleepInhibit.set",
      expect.objectContaining({ mode: "onPower" }),
    );
  });

  it("mints a fresh idempotencyKey per call", async () => {
    const call = vi.fn(async (_method: string, _params: { idempotencyKey: string }) => ({
      supported: true,
      platform: "darwin",
      mode: "off" as const,
      active: false,
    }));
    const actions = machineRpcToMachineSettingsActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    await actions.fetchSleepInhibit();
    await actions.fetchSleepInhibit();

    const keys = call.mock.calls.map(([, params]) => params.idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });
});
