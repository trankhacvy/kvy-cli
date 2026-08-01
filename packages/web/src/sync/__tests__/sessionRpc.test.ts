import type { EncryptedBox } from "@kvy/wire";
import { describe, expect, it, vi } from "vitest";
import type { ApiSocket, RpcCallResult } from "../apiSocket.js";
import { createSessionRpcClient, type SessionRpcCrypto, SessionRpcError } from "../sessionRpc.js";

const box = (payload: unknown): EncryptedBox => ({ t: "enc", v: 1, c: JSON.stringify(payload) });

/** Identity "crypto" double — round-trips plain objects through JSON inside
 * an EncryptedBox shell, no real sealing. `openOverride` lets a test force a
 * decrypt failure (`null`) or return a payload that fails schema validation. */
function fakeCrypto(openOverride?: (box: EncryptedBox) => unknown): SessionRpcCrypto {
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

describe("createSessionRpcClient", () => {
  it("targets 's:<sessionId>:<method>' and seals params under the given crypto client", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({ ok: true }),
      }),
    );
    const client = createSessionRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      sessionId: "sess-42",
    });

    await client.call("interrupt", {});

    expect(rpcCall).toHaveBeenCalledTimes(1);
    expect(rpcCall).toHaveBeenCalledWith(
      "s:sess-42:interrupt",
      "interrupt",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    const [, , params] = rpcCall.mock.calls[0] ?? [];
    expect(JSON.parse(params?.c ?? "null")).toEqual({});
  });

  it("returns the decrypted, schema-validated result on success", async () => {
    const client = createSessionRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ queued: true }) })),
      crypto: fakeCrypto(),
      sessionId: "sess-1",
    });

    const result = await client.call("message", {
      envelope: {
        id: "env-1",
        time: 1,
        role: "user",
        ev: { t: "text", md: "hi" },
      },
    });

    expect(result).toEqual({ queued: true });
  });

  it("returns a losing perm.answer result normally (does not throw)", async () => {
    const winningDecision = { kind: "allow" as const, scope: "once" as const };
    const client = createSessionRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ ok: false, reason: "already-answered", decision: winningDecision }),
      })),
      crypto: fakeCrypto(),
      sessionId: "sess-1",
    });

    const result = await client.call("perm.answer", {
      reqId: "req-1",
      decision: { kind: "deny" },
    });

    expect(result).toEqual({ ok: false, reason: "already-answered", decision: winningDecision });
  });

  it("targets 's:<sessionId>:stop' and returns the decrypted { ok } result", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({ ok: true }),
      }),
    );
    const client = createSessionRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      sessionId: "sess-42",
    });

    const result = await client.call("stop", { force: true });

    expect(rpcCall).toHaveBeenCalledWith(
      "s:sess-42:stop",
      "stop",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    const [, , params] = rpcCall.mock.calls[0] ?? [];
    expect(JSON.parse(params?.c ?? "null")).toEqual({ force: true });
    expect(result).toEqual({ ok: true });
  });

  it("throws SessionRpcError when the transport reports failure", async () => {
    const client = createSessionRpcClient({
      socket: fakeSocket(async () => ({ ok: false, error: "target-offline" })),
      crypto: fakeCrypto(),
      sessionId: "sess-1",
    });

    await expect(client.call("interrupt", {})).rejects.toThrow(SessionRpcError);
    await expect(client.call("interrupt", {})).rejects.toThrow("target-offline");
  });

  it("throws SessionRpcError when the sealed result fails to decrypt", async () => {
    const client = createSessionRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ ok: true }) })),
      crypto: fakeCrypto(() => null),
      sessionId: "sess-1",
    });

    await expect(client.call("interrupt", {})).rejects.toThrow(/decrypt/);
  });

  it("throws SessionRpcError when the decrypted result fails schema validation", async () => {
    const client = createSessionRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ garbage: 1 }) })),
      crypto: fakeCrypto(() => ({ garbage: 1 })),
      sessionId: "sess-1",
    });

    await expect(client.call("interrupt", {})).rejects.toThrow(/schema validation/);
  });
});
