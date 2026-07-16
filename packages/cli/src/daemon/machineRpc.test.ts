import { open, seal } from "@falcon/crypto";
import type {
  AdoptMirrorResult,
  AdoptTakeResult,
  EncryptedBox,
  FsListResult,
  FsMkdirResult,
  SpawnParams,
  SpawnResult,
} from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import { type MachineRpcDeps, registerMachineRpcHandlers } from "./machineRpc.js";

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

/** Every `MachineRpcDeps` field besides `machineId`/`dek`/`socket`, defaulted to a never-called `vi.fn()` — individual tests override what they exercise. */
function baseHandlerDeps(): Pick<
  MachineRpcDeps,
  "spawnSession" | "resumeSession" | "adoptTake" | "adoptMirror"
> {
  return {
    spawnSession: vi.fn(),
    resumeSession: vi.fn(),
    adoptTake: vi.fn(),
    adoptMirror: vi.fn(),
  };
}

function register(
  socket: FakeSocket,
  overrides: Partial<MachineRpcDeps> = {},
): ReturnType<typeof registerMachineRpcHandlers> {
  return registerMachineRpcHandlers({
    machineId: "mach_1",
    dek: DEK,
    socket: socket as unknown as import("socket.io-client").Socket,
    ...baseHandlerDeps(),
    ...overrides,
  });
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
  it("registers every machine RPC target on connect", () => {
    const socket = new FakeSocket();
    register(socket);

    socket.trigger("connect");

    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:spawn" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:resumeSession" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:fs.list" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:fs.mkdir" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:adopt.take" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:adopt.mirror" },
    });
  });

  it("registers immediately if the socket is already connected", () => {
    const socket = new FakeSocket();
    socket.connected = true;
    register(socket);

    expect(socket.emitted).toHaveLength(6);
  });

  describe("spawn", () => {
    it("decrypts params, calls spawnSession, and seals the result", async () => {
      const socket = new FakeSocket();
      const spawnSession = vi.fn(async (): Promise<SpawnResult> => ({ sessionId: "sess_1" }));
      register(socket, { spawnSession });

      const params = spawnParams();
      const response = await callAndAwaitAck(socket, "spawn", seal(params, DEK));

      expect(spawnSession).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ sessionId: "sess_1" });
    });

    it("replays the cached result for a retried idempotencyKey instead of spawning again", async () => {
      const socket = new FakeSocket();
      const spawnSession = vi.fn(async (): Promise<SpawnResult> => ({ sessionId: "sess_1" }));
      register(socket, { spawnSession });

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
      register(socket, { spawnSession });

      const params = spawnParams();
      const first = await callAndAwaitAck(socket, "spawn", seal(params, DEK));
      expect(open(first, DEK)).toEqual({ ok: false, error: "handler-error" });

      const second = await callAndAwaitAck(socket, "spawn", seal(params, DEK));
      expect(spawnSession).toHaveBeenCalledTimes(2);
      expect(open(second, DEK)).toEqual({ sessionId: "sess_2" });
    });

    it("does NOT cache a requiresApproval result — a retry with the same key re-runs spawnSession", async () => {
      const socket = new FakeSocket();
      const spawnSession = vi
        .fn()
        .mockResolvedValueOnce({
          requiresApproval: { action: "create-directory", directory: "/tmp/proj" },
        } satisfies SpawnResult)
        .mockResolvedValueOnce({ sessionId: "sess_3" } satisfies SpawnResult);
      register(socket, { spawnSession });

      const params = spawnParams();
      const first = await callAndAwaitAck(socket, "spawn", seal(params, DEK));
      expect(open(first, DEK)).toEqual({
        requiresApproval: { action: "create-directory", directory: "/tmp/proj" },
      });

      // Same idempotencyKey, retried after the caller created the directory —
      // must actually re-run spawnSession, not replay the stale requiresApproval.
      const second = await callAndAwaitAck(socket, "spawn", seal(params, DEK));
      expect(spawnSession).toHaveBeenCalledTimes(2);
      expect(open(second, DEK)).toEqual({ sessionId: "sess_3" });
    });

    it("distinguishes idempotency keys — a different key always spawns fresh", async () => {
      const socket = new FakeSocket();
      const spawnSession = vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "sess_a" })
        .mockResolvedValueOnce({ sessionId: "sess_b" });
      register(socket, { spawnSession });

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

    it("replies with a sealed error when spawnSession's result fails its own schema", async () => {
      const socket = new FakeSocket();
      register(socket, {
        // `sessionId` is optional on `SpawnResultSchema` (the requiresApproval
        // variant omits it entirely), so a wrong *type* — not just a missing
        // field — is what actually fails validation here.
        spawnSession: vi.fn(async () => ({ sessionId: 42 }) as unknown as SpawnResult),
      });

      const response = await callAndAwaitAck(socket, "spawn", seal(spawnParams(), DEK));
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-result" });
    });

    it("replies with a sealed error when decrypted params fail SpawnParamsSchema", async () => {
      const socket = new FakeSocket();
      register(socket);

      const response = await callAndAwaitAck(
        socket,
        "spawn",
        seal({ provider: "not-a-provider" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });

    it("replies with a sealed error when spawnSession throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        spawnSession: vi.fn(async () => {
          throw new Error("boom");
        }),
      });

      const response = await callAndAwaitAck(socket, "spawn", seal(spawnParams(), DEK));
      expect(open(response, DEK)).toEqual({ ok: false, error: "handler-error" });
    });
  });

  describe("resumeSession method", () => {
    it("decrypts params, calls resumeSession, and seals a bare {ok:true}", async () => {
      const socket = new FakeSocket();
      const resumeSession = vi.fn(async () => undefined);
      register(socket, { resumeSession });

      const response = await callAndAwaitAck(
        socket,
        "resumeSession",
        seal({ sessionId: "sess_1" }, DEK),
      );

      expect(resumeSession).toHaveBeenCalledExactlyOnceWith("sess_1");
      expect(open(response, DEK)).toEqual({ ok: true });
    });

    it("has no idempotency-key replay — a second call always calls resumeSession again", async () => {
      const socket = new FakeSocket();
      const resumeSession = vi.fn(async () => undefined);
      register(socket, { resumeSession });

      await callAndAwaitAck(socket, "resumeSession", seal({ sessionId: "sess_1" }, DEK));
      await callAndAwaitAck(socket, "resumeSession", seal({ sessionId: "sess_1" }, DEK));

      expect(resumeSession).toHaveBeenCalledTimes(2);
    });

    it("replies with a sealed error when decrypted params fail ResumeSessionParamsSchema", async () => {
      const socket = new FakeSocket();
      register(socket);

      const response = await callAndAwaitAck(socket, "resumeSession", seal({}, DEK));
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });

    it("replies with a sealed error when resumeSession throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        resumeSession: vi.fn(async () => {
          throw new Error("no such session");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "resumeSession",
        seal({ sessionId: "sess_1" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "handler-error" });
    });
  });

  describe("fs.list", () => {
    it("decrypts params, calls listDirectory, and seals the result", async () => {
      const socket = new FakeSocket();
      const listDirectory = vi.fn(
        async (): Promise<FsListResult> => ({
          path: "/home/me",
          parent: "/home",
          entries: [{ name: "projects", isDirectory: true }],
        }),
      );
      register(socket, { listDirectory });

      const params = { idempotencyKey: "idem_fs_1", path: "/home/me" };
      const response = await callAndAwaitAck(socket, "fs.list", seal(params, DEK));

      expect(listDirectory).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        path: "/home/me",
        parent: "/home",
        entries: [{ name: "projects", isDirectory: true }],
      });
    });

    it("replies with a sealed error when listDirectory throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
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
  });

  describe("fs.mkdir", () => {
    it("decrypts params, calls createDirectory, and seals the result", async () => {
      const socket = new FakeSocket();
      const createDirectory = vi.fn(async (): Promise<FsMkdirResult> => ({ ok: true }));
      register(socket, { createDirectory });

      const params = { idempotencyKey: "idem_mk_1", path: "/tmp/new-project" };
      const response = await callAndAwaitAck(socket, "fs.mkdir", seal(params, DEK));

      expect(createDirectory).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ ok: true });
    });

    it("replies with a sealed error when params fail schema validation (missing path)", async () => {
      const socket = new FakeSocket();
      register(socket, { createDirectory: vi.fn() });

      const response = await callAndAwaitAck(
        socket,
        "fs.mkdir",
        seal({ idempotencyKey: "idem_mk_2" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });
  });

  describe("adopt.take", () => {
    function adoptTakeParams(overrides: Record<string, unknown> = {}) {
      return {
        idempotencyKey: "idem_take_1",
        providerSessionId: "prov_1",
        mode: "takeover" as const,
        ...overrides,
      };
    }

    it("decrypts params, calls adoptTake, and seals the result", async () => {
      const socket = new FakeSocket();
      const adoptTake = vi.fn(async (): Promise<AdoptTakeResult> => ({ sessionId: "sess_9" }));
      register(socket, { adoptTake });

      const params = adoptTakeParams();
      const response = await callAndAwaitAck(socket, "adopt.take", seal(params, DEK));

      expect(adoptTake).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ sessionId: "sess_9" });
    });

    it("carries an optional mid-turn warning through untouched", async () => {
      const socket = new FakeSocket();
      const adoptTake = vi.fn(
        async (): Promise<AdoptTakeResult> => ({ sessionId: "sess_9", warning: "interrupted" }),
      );
      register(socket, { adoptTake });

      const response = await callAndAwaitAck(socket, "adopt.take", seal(adoptTakeParams(), DEK));
      expect(open(response, DEK)).toEqual({ sessionId: "sess_9", warning: "interrupted" });
    });

    it("replays the cached result for a retried idempotencyKey instead of taking over again", async () => {
      const socket = new FakeSocket();
      const adoptTake = vi.fn(async (): Promise<AdoptTakeResult> => ({ sessionId: "sess_9" }));
      register(socket, { adoptTake });

      const params = adoptTakeParams();
      await callAndAwaitAck(socket, "adopt.take", seal(params, DEK));
      await callAndAwaitAck(socket, "adopt.take", seal(params, DEK));

      expect(adoptTake).toHaveBeenCalledOnce();
    });

    it("does NOT cache a failed adopt.take attempt", async () => {
      const socket = new FakeSocket();
      const adoptTake = vi
        .fn()
        .mockRejectedValueOnce(new Error("no such provider session"))
        .mockResolvedValueOnce({ sessionId: "sess_10" });
      register(socket, { adoptTake });

      const params = adoptTakeParams();
      const first = await callAndAwaitAck(socket, "adopt.take", seal(params, DEK));
      expect(open(first, DEK)).toEqual({ ok: false, error: "handler-error" });

      const second = await callAndAwaitAck(socket, "adopt.take", seal(params, DEK));
      expect(adoptTake).toHaveBeenCalledTimes(2);
      expect(open(second, DEK)).toEqual({ sessionId: "sess_10" });
    });

    it("replies with a sealed error when params fail AdoptTakeParamsSchema", async () => {
      const socket = new FakeSocket();
      register(socket);

      const response = await callAndAwaitAck(
        socket,
        "adopt.take",
        seal({ providerSessionId: "p1", mode: "not-a-mode" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });
  });

  describe("adopt.mirror", () => {
    function adoptMirrorParams(overrides: Record<string, unknown> = {}) {
      return {
        idempotencyKey: "idem_mirror_1",
        providerSessionId: "prov_1",
        ...overrides,
      };
    }

    it("decrypts params, calls adoptMirror, and seals the chunk result", async () => {
      const socket = new FakeSocket();
      const adoptMirror = vi.fn(
        async (): Promise<AdoptMirrorResult> => ({ chunk: "{}\n", nextCursor: null, done: true }),
      );
      register(socket, { adoptMirror });

      const params = adoptMirrorParams();
      const response = await callAndAwaitAck(socket, "adopt.mirror", seal(params, DEK));

      expect(adoptMirror).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ chunk: "{}\n", nextCursor: null, done: true });
    });

    it("replays the cached chunk for a retried idempotencyKey instead of re-reading", async () => {
      const socket = new FakeSocket();
      const adoptMirror = vi.fn(
        async (): Promise<AdoptMirrorResult> => ({ chunk: "a", nextCursor: 1, done: false }),
      );
      register(socket, { adoptMirror });

      const params = adoptMirrorParams();
      await callAndAwaitAck(socket, "adopt.mirror", seal(params, DEK));
      await callAndAwaitAck(socket, "adopt.mirror", seal(params, DEK));

      expect(adoptMirror).toHaveBeenCalledOnce();
    });

    it("does NOT replay a stale chunk when the same idempotencyKey is reused across different cursors — each cursor's params get their own cache entry", async () => {
      const socket = new FakeSocket();
      const adoptMirror = vi
        .fn()
        .mockResolvedValueOnce({ chunk: "chunk-0", nextCursor: 100, done: false })
        .mockResolvedValueOnce({ chunk: "chunk-100", nextCursor: null, done: true });
      register(socket, { adoptMirror });

      // Same idempotencyKey reused across a paginated sequence (misuse —
      // a real client should mint a fresh key per chunk — but must not
      // silently replay the first chunk for a differently-cursored call).
      const first = await callAndAwaitAck(
        socket,
        "adopt.mirror",
        seal(adoptMirrorParams({ cursor: 0 }), DEK),
      );
      const second = await callAndAwaitAck(
        socket,
        "adopt.mirror",
        seal(adoptMirrorParams({ cursor: 100 }), DEK),
      );

      expect(adoptMirror).toHaveBeenCalledTimes(2);
      expect(open(first, DEK)).toEqual({ chunk: "chunk-0", nextCursor: 100, done: false });
      expect(open(second, DEK)).toEqual({ chunk: "chunk-100", nextCursor: null, done: true });
    });

    it("replies with a sealed error when adoptMirror throws (e.g. unreadable transcript)", async () => {
      const socket = new FakeSocket();
      register(socket, {
        adoptMirror: vi.fn(async () => {
          throw new Error("ENOENT");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "adopt.mirror",
        seal(adoptMirrorParams(), DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "handler-error" });
    });

    it("replies with a sealed error when params fail AdoptMirrorParamsSchema", async () => {
      const socket = new FakeSocket();
      register(socket);

      const response = await callAndAwaitAck(
        socket,
        "adopt.mirror",
        seal({ providerSessionId: "p1" }, DEK), // missing idempotencyKey
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });
  });

  it("replies with a sealed error for an unknown method", async () => {
    const socket = new FakeSocket();
    register(socket);

    const response = await callAndAwaitAck(socket, "nonsense", seal({}, DEK));
    expect(open(response, DEK)).toEqual({ ok: false, error: "unknown-method" });
  });

  it("replies with a sealed error when params is not a well-formed EncryptedBox", async () => {
    const socket = new FakeSocket();
    register(socket);

    const response = await callAndAwaitAck(socket, "spawn", { not: "a box" });
    expect(open(response, DEK)).toEqual({ ok: false, error: "malformed-params" });
  });

  it("replies with a sealed error when params fail to decrypt under this machine's dek", async () => {
    const socket = new FakeSocket();
    register(socket);

    const wrongDek = new Uint8Array(32).fill(9);
    const response = await callAndAwaitAck(socket, "spawn", seal(spawnParams(), wrongDek));
    expect(open(response, DEK)).toEqual({ ok: false, error: "decrypt-failed" });
  });

  it("stop() removes this module's listeners from the socket", () => {
    const socket = new FakeSocket();
    const handle = register(socket);

    expect(socket.handlers.get("rpc-request")?.length).toBe(1);
    handle.stop();
    expect(socket.handlers.get("rpc-request")?.length).toBe(0);
    expect(socket.handlers.get("connect")?.length).toBe(0);
  });
});
