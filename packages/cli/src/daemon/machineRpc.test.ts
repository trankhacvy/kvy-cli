import { open, seal } from "@falcon/crypto";
import type {
  EncryptedBox,
  FsListResult,
  FsMkdirResult,
  SpawnParams,
  SpawnResult,
} from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import { registerMachineRpcHandlers } from "./machineRpc.js";

/** Minimal fake standing in for a socket.io-client `Socket` (mirrors rpc/sessionRpc.test.ts's FakeSocket). */
class FakeSocket {
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  emitted: { event: string; payload: unknown }[] = [];
  connected = false;

  on(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(
      event,
      list.filter((h) => h !== handler),
    );
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  trigger(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

const DEK = new Uint8Array(32).fill(3);

function spawnParams(overrides: Partial<SpawnParams> = {}): SpawnParams {
  return {
    idempotencyKey: "idem_1",
    workspaceId: "ws_1",
    directory: "/tmp/proj",
    provider: "claude-code",
    permissionMode: "default",
    ...overrides,
  };
}

async function callAndAwaitAck(
  socket: FakeSocket,
  method: string,
  params: unknown,
): Promise<EncryptedBox> {
  return new Promise((resolve) => {
    socket.trigger("rpc-request", { method, params }, (response: EncryptedBox) =>
      resolve(response),
    );
  });
}

describe("registerMachineRpcHandlers", () => {
  it("registers the spawn/fs.list/fs.mkdir targets on connect", () => {
    const socket = new FakeSocket();
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession: vi.fn(),
    });

    socket.trigger("connect");

    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:spawn" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:fs.list" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:fs.mkdir" },
    });
  });

  it("registers immediately if the socket is already connected", () => {
    const socket = new FakeSocket();
    socket.connected = true;
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession: vi.fn(),
    });

    expect(socket.emitted).toHaveLength(3);
  });

  it("decrypts params, calls spawnSession, and seals the result", async () => {
    const socket = new FakeSocket();
    const spawnSession = vi.fn(async (): Promise<SpawnResult> => ({ sessionId: "sess_1" }));
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession,
    });

    const params = spawnParams();
    const response = await callAndAwaitAck(socket, "spawn", seal(params, DEK));

    expect(spawnSession).toHaveBeenCalledExactlyOnceWith(params);
    expect(open(response, DEK)).toEqual({ sessionId: "sess_1" });
  });

  it("replays the cached result for a retried idempotencyKey instead of spawning again", async () => {
    const socket = new FakeSocket();
    const spawnSession = vi.fn(async (): Promise<SpawnResult> => ({ sessionId: "sess_1" }));
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession,
    });

    const params = spawnParams();
    const first = await callAndAwaitAck(socket, "spawn", seal(params, DEK));
    const second = await callAndAwaitAck(socket, "spawn", seal(params, DEK));

    expect(spawnSession).toHaveBeenCalledOnce();
    expect(open(first, DEK)).toEqual({ sessionId: "sess_1" });
    expect(open(second, DEK)).toEqual({ sessionId: "sess_1" });
  });

  it("does NOT cache a failed spawn attempt — a retry re-runs spawnSession", async () => {
    const socket = new FakeSocket();
    const spawnSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("workspace path rejected"))
      .mockResolvedValueOnce({ sessionId: "sess_2" });
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession,
    });

    const params = spawnParams();
    const first = await callAndAwaitAck(socket, "spawn", seal(params, DEK));
    expect(open(first, DEK)).toEqual({ ok: false, error: "handler-error" });

    const second = await callAndAwaitAck(socket, "spawn", seal(params, DEK));
    expect(spawnSession).toHaveBeenCalledTimes(2);
    expect(open(second, DEK)).toEqual({ sessionId: "sess_2" });
  });

  it("distinguishes idempotency keys — a different key always spawns fresh", async () => {
    const socket = new FakeSocket();
    const spawnSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "sess_a" })
      .mockResolvedValueOnce({ sessionId: "sess_b" });
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession,
    });

    const a = await callAndAwaitAck(
      socket,
      "spawn",
      seal(spawnParams({ idempotencyKey: "idem_a" }), DEK),
    );
    const b = await callAndAwaitAck(
      socket,
      "spawn",
      seal(spawnParams({ idempotencyKey: "idem_b" }), DEK),
    );

    expect(spawnSession).toHaveBeenCalledTimes(2);
    expect(open(a, DEK)).toEqual({ sessionId: "sess_a" });
    expect(open(b, DEK)).toEqual({ sessionId: "sess_b" });
  });

  it("replies with a sealed error for an unknown method", async () => {
    const socket = new FakeSocket();
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession: vi.fn(),
    });

    const response = await callAndAwaitAck(socket, "nonsense", seal({}, DEK));
    expect(open(response, DEK)).toEqual({ ok: false, error: "unknown-method" });
  });

  it("replies with a sealed error when params is not a well-formed EncryptedBox", async () => {
    const socket = new FakeSocket();
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession: vi.fn(),
    });

    const response = await callAndAwaitAck(socket, "spawn", { not: "a box" });
    expect(open(response, DEK)).toEqual({ ok: false, error: "malformed-params" });
  });

  it("replies with a sealed error when params fail to decrypt under this machine's dek", async () => {
    const socket = new FakeSocket();
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession: vi.fn(),
    });

    const wrongDek = new Uint8Array(32).fill(9);
    const response = await callAndAwaitAck(socket, "spawn", seal(spawnParams(), wrongDek));
    expect(open(response, DEK)).toEqual({ ok: false, error: "decrypt-failed" });
  });

  it("replies with a sealed error when decrypted params fail SpawnParamsSchema", async () => {
    const socket = new FakeSocket();
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession: vi.fn(),
    });

    const response = await callAndAwaitAck(
      socket,
      "spawn",
      seal({ provider: "not-a-provider" }, DEK),
    );
    expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
  });

  it("replies with a sealed error when spawnSession throws", async () => {
    const socket = new FakeSocket();
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    const response = await callAndAwaitAck(socket, "spawn", seal(spawnParams(), DEK));
    expect(open(response, DEK)).toEqual({ ok: false, error: "handler-error" });
  });

  it("replies with a sealed error when spawnSession's result fails its own schema", async () => {
    const socket = new FakeSocket();
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession: vi.fn(async () => ({ sessionId: 42 }) as unknown as SpawnResult),
    });

    const response = await callAndAwaitAck(socket, "spawn", seal(spawnParams(), DEK));
    expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-result" });
  });

  it("fs.list: decrypts params, calls listDirectory, and seals the result", async () => {
    const socket = new FakeSocket();
    const listDirectory = vi.fn(
      async (): Promise<FsListResult> => ({
        path: "/home/me",
        parent: "/home",
        entries: [{ name: "projects", isDirectory: true }],
      }),
    );
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession: vi.fn(),
      listDirectory,
    });

    const params = { idempotencyKey: "idem_fs_1", path: "/home/me" };
    const response = await callAndAwaitAck(socket, "fs.list", seal(params, DEK));

    expect(listDirectory).toHaveBeenCalledExactlyOnceWith(params);
    expect(open(response, DEK)).toEqual({
      path: "/home/me",
      parent: "/home",
      entries: [{ name: "projects", isDirectory: true }],
    });
  });

  it("fs.list: replies with a sealed error when listDirectory throws", async () => {
    const socket = new FakeSocket();
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession: vi.fn(),
      listDirectory: vi.fn(async () => {
        throw new Error("directory not found");
      }),
    });

    const response = await callAndAwaitAck(
      socket,
      "fs.list",
      seal({ idempotencyKey: "idem_fs_2" }, DEK),
    );
    expect(open(response, DEK)).toEqual({ ok: false, error: "handler-error" });
  });

  it("fs.mkdir: decrypts params, calls createDirectory, and seals the result", async () => {
    const socket = new FakeSocket();
    const createDirectory = vi.fn(async (): Promise<FsMkdirResult> => ({ ok: true }));
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession: vi.fn(),
      createDirectory,
    });

    const params = { idempotencyKey: "idem_mk_1", path: "/tmp/new-project" };
    const response = await callAndAwaitAck(socket, "fs.mkdir", seal(params, DEK));

    expect(createDirectory).toHaveBeenCalledExactlyOnceWith(params);
    expect(open(response, DEK)).toEqual({ ok: true });
  });

  it("fs.mkdir: replies with a sealed error when params fail schema validation (missing path)", async () => {
    const socket = new FakeSocket();
    registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession: vi.fn(),
      createDirectory: vi.fn(),
    });

    const response = await callAndAwaitAck(
      socket,
      "fs.mkdir",
      seal({ idempotencyKey: "idem_mk_2" }, DEK),
    );
    expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
  });

  it("stop() removes this module's listeners from the socket", () => {
    const socket = new FakeSocket();
    const handle = registerMachineRpcHandlers({
      machineId: "mach_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      spawnSession: vi.fn(),
    });

    expect(socket.handlers.get("rpc-request")?.length).toBe(1);
    handle.stop();
    expect(socket.handlers.get("rpc-request")?.length).toBe(0);
    expect(socket.handlers.get("connect")?.length).toBe(0);
  });
});
