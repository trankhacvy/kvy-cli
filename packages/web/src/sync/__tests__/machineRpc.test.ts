import type { EncryptedBox } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import type { ApiSocket, RpcCallResult } from "../apiSocket.js";
import { createMachineRpcClient, type MachineRpcCrypto, MachineRpcError } from "../machineRpc.js";

const box = (payload: unknown): EncryptedBox => ({ t: "enc", v: 1, c: JSON.stringify(payload) });

function fakeCrypto(openOverride?: (box: EncryptedBox) => unknown): MachineRpcCrypto {
  return {
    async seal(data) {
      return box(data);
    },
    async open<T>(b: EncryptedBox) {
      if (openOverride) return openOverride(b) as T;
      return JSON.parse(b.c) as T;
    },
  };
}

function fakeSocket(
  rpcCall: (target: string, method: string, params: EncryptedBox) => Promise<RpcCallResult>,
): Pick<ApiSocket, "rpcCall"> {
  return { rpcCall };
}

describe("createMachineRpcClient", () => {
  it("targets 'm:<machineId>:<method>' and seals params under the given crypto client", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({ sessionId: "sess-1" }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-42",
    });

    await client.call("spawn", {
      idempotencyKey: "idem-1",
      workspaceId: "/repo",
      directory: "/repo",
      provider: "claude-code",
      permissionMode: "default",
    });

    expect(rpcCall).toHaveBeenCalledTimes(1);
    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-42:spawn",
      "spawn",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
  });

  it("returns the decrypted, schema-validated spawn result on success", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ sessionId: "sess-1" }) })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("spawn", {
      idempotencyKey: "idem-1",
      workspaceId: "/repo",
      directory: "/repo",
      provider: "claude-code",
      permissionMode: "default",
    });

    expect(result).toEqual({ sessionId: "sess-1" });
  });

  it("returns a requiresApproval spawn result normally (does not throw)", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ requiresApproval: { action: "create-directory", directory: "/x" } }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("spawn", {
      idempotencyKey: "idem-1",
      workspaceId: "/x",
      directory: "/x",
      provider: "claude-code",
      permissionMode: "default",
    });

    expect(result).toEqual({
      requiresApproval: { action: "create-directory", directory: "/x" },
    });
  });

  it("round-trips an fs.list call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ path: "/home/me", parent: "/home", entries: [] }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("fs.list", { idempotencyKey: "idem-2" });
    expect(result).toEqual({ path: "/home/me", parent: "/home", entries: [] });
  });

  it("round-trips an fs.mkdir call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ ok: true }) })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("fs.mkdir", { idempotencyKey: "idem-3", path: "/tmp/x" });
    expect(result).toEqual({ ok: true });
  });

  it("throws MachineRpcError when the transport reports failure", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: false, error: "target-offline" })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    await expect(client.call("fs.list", { idempotencyKey: "idem-1" })).rejects.toThrow(
      MachineRpcError,
    );
    await expect(client.call("fs.list", { idempotencyKey: "idem-1" })).rejects.toThrow(
      "target-offline",
    );
  });

  it("throws MachineRpcError when the sealed result fails to decrypt", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ ok: true }) })),
      crypto: fakeCrypto(() => null),
      machineId: "mach-1",
    });

    await expect(client.call("fs.mkdir", { idempotencyKey: "idem-1", path: "/x" })).rejects.toThrow(
      /decrypt/,
    );
  });

  it("throws MachineRpcError when the decrypted result fails schema validation", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ garbage: 1 }) })),
      crypto: fakeCrypto(() => ({ garbage: 1 })),
      machineId: "mach-1",
    });

    await expect(client.call("fs.mkdir", { idempotencyKey: "idem-1", path: "/x" })).rejects.toThrow(
      /schema validation/,
    );
  });
});
