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

  it("round-trips a workspace.register call and result (Flow 3 Piece A)", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({ ok: true, result: box({ ok: true }) })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("workspace.register", {
      idempotencyKey: "idem-ws-1",
      directory: "/fresh/repo",
    });
    expect(result).toEqual({ ok: true });
  });

  it("round-trips an adopt.list call and result", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({ items: [{ providerSessionId: "prov-1", lastActivityAt: 1_000 }] }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("adopt.list", {
      idempotencyKey: "idem-list",
      workspaceId: "/repo",
    });

    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-1:adopt.list",
      "adopt.list",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    expect(result).toEqual({ items: [{ providerSessionId: "prov-1", lastActivityAt: 1_000 }] });
  });

  it("round-trips an adopt.take call and result", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({ sessionId: "sess-new", warning: "mid-turn interrupt" }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("adopt.take", {
      idempotencyKey: "idem-4",
      providerSessionId: "prov-1",
      mode: "takeover",
    });

    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-1:adopt.take",
      "adopt.take",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    expect(result).toEqual({ sessionId: "sess-new", warning: "mid-turn interrupt" });
  });

  it("round-trips an adopt.mirror call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ chunk: "hello", nextCursor: 5, done: false }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("adopt.mirror", {
      idempotencyKey: "idem-5",
      providerSessionId: "prov-1",
      cursor: 0,
    });

    expect(result).toEqual({ chunk: "hello", nextCursor: 5, done: false });
  });

  it("round-trips a git.status call and result", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({
          branch: "main",
          ahead: 1,
          behind: 0,
          files: [{ path: "src/a.ts", status: "modified" }],
        }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("git.status", {
      idempotencyKey: "idem-6",
      worktree: "/repo",
    });

    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-1:git.status",
      "git.status",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    expect(result).toEqual({
      branch: "main",
      ahead: 1,
      behind: 0,
      files: [{ path: "src/a.ts", status: "modified" }],
    });
  });

  it("round-trips a git.diff call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ inline: "diff --git a/x b/x", truncated: false }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("git.diff", {
      idempotencyKey: "idem-7",
      worktree: "/repo",
      baseRef: "main",
    });

    expect(result).toEqual({ inline: "diff --git a/x b/x", truncated: false });
  });

  it("round-trips a git.files call and result", async () => {
    const rpcCall = vi.fn(
      async (_target: string, _method: string, _params: EncryptedBox): Promise<RpcCallResult> => ({
        ok: true,
        result: box({ files: ["README.md", "src/a.ts"] }),
      }),
    );
    const client = createMachineRpcClient({
      socket: fakeSocket(rpcCall),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("git.files", {
      idempotencyKey: "idem-8",
      worktree: "/repo",
    });

    expect(rpcCall).toHaveBeenCalledWith(
      "m:mach-1:git.files",
      "git.files",
      expect.objectContaining({ t: "enc", v: 1 }),
    );
    expect(result).toEqual({ files: ["README.md", "src/a.ts"] });
  });

  it("round-trips an fs.read call and result", async () => {
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ inline: "const a = 1;\n", truncated: false }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    const result = await client.call("fs.read", {
      idempotencyKey: "idem-9",
      worktree: "/repo",
      path: "src/a.ts",
    });

    expect(result).toEqual({ inline: "const a = 1;\n", truncated: false });
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

  it("throws MachineRpcError with the daemon handler's own message (not a generic schema-validation error) when the daemon replies with a sealed {ok:false,error} box", async () => {
    // Reproduces the daemon's `onRpcRequest` catch path (`daemon/machineRpc.ts`):
    // a thrown `GitExecError`/`Error` is sealed as `{ok:false, error: <message>}`,
    // which structurally can never satisfy a real result schema — this must be
    // special-cased BEFORE schema validation, or the caller only ever sees a
    // useless "'method' RPC result failed schema validation" instead of the
    // actual git stderr (docs/features/git-write-actions.md's credential-failure
    // UX depends on this).
    const client = createMachineRpcClient({
      socket: fakeSocket(async () => ({
        ok: true,
        result: box({ ok: false, error: "fatal: could not read Username for 'https://...'" }),
      })),
      crypto: fakeCrypto(),
      machineId: "mach-1",
    });

    await expect(
      client.call("git.push", { idempotencyKey: "idem-8", worktree: "/repo" }),
    ).rejects.toThrow("fatal: could not read Username for 'https://...'");
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
