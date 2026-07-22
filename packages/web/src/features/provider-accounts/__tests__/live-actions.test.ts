import { describe, expect, it, vi } from "vitest";
import type { MachineRpcClient } from "@/sync/machineRpc";
import { machineRpcToProviderAccountActions } from "../live-actions";

function fakeRpc(call: MachineRpcClient["call"]): MachineRpcClient {
  return { call };
}

describe("machineRpcToProviderAccountActions", () => {
  it("fetchAccount calls provider.account with the given provider and returns the result as-is", async () => {
    const call = vi.fn(async () => ({
      provider: "claude-code",
      authenticated: true,
      authType: "oauth",
      email: "dev@example.com",
      organization: "Acme Org",
      organizationRole: "admin",
      billingType: "stripe_subscription",
      lastRefreshedAt: 1_700_000_000_000,
      usage: [{ label: "Weekly", percentUsed: 93, resetsAt: "2026-07-20T18:00:00.000Z" }],
    }));
    const actions = machineRpcToProviderAccountActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.fetchAccount("claude-code");

    expect(result).toEqual({
      provider: "claude-code",
      authenticated: true,
      authType: "oauth",
      email: "dev@example.com",
      organization: "Acme Org",
      organizationRole: "admin",
      billingType: "stripe_subscription",
      lastRefreshedAt: 1_700_000_000_000,
      usage: [{ label: "Weekly", percentUsed: 93, resetsAt: "2026-07-20T18:00:00.000Z" }],
    });
    expect(call).toHaveBeenCalledWith(
      "provider.account",
      expect.objectContaining({ provider: "claude-code" }),
    );
  });

  it("fetchAccount surfaces an unauthenticated result unchanged", async () => {
    const call = vi.fn(async () => ({ provider: "codex", authenticated: false }));
    const actions = machineRpcToProviderAccountActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    const result = await actions.fetchAccount("codex");
    expect(result).toEqual({ provider: "codex", authenticated: false });
  });

  it("mints a fresh idempotencyKey per call", async () => {
    const call = vi.fn(async (_method: string, params: { idempotencyKey: string }) => ({
      provider: "codex" as const,
      authenticated: false,
      idempotencyKeySeen: params.idempotencyKey,
    }));
    const actions = machineRpcToProviderAccountActions(
      fakeRpc(call as unknown as MachineRpcClient["call"]),
    );

    await actions.fetchAccount("codex");
    await actions.fetchAccount("codex");

    const keys = call.mock.calls.map(([, params]) => params.idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });
});
