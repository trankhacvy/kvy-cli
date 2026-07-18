import { open, seal } from "@falcon/crypto";
import { createEnvelope, type EncryptedBox } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import { registerSessionRpcHandlers, type SessionRpcHandlers } from "./sessionRpc.js";

/** Minimal fake standing in for a socket.io-client `Socket` (mirrors daemon/machineClient.test.ts's FakeSocket). */
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

const DEK = new Uint8Array(32).fill(7);

function noopHandlers(overrides: Partial<SessionRpcHandlers> = {}): SessionRpcHandlers {
  return {
    message: vi.fn(async () => ({ queued: true })),
    interrupt: vi.fn(async () => ({ ok: true })),
    takeControl: vi.fn(async () => ({ ok: true })),
    setMode: vi.fn(async () => ({ ok: true })),
    permAnswer: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
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

describe("registerSessionRpcHandlers", () => {
  it("registers all six session RPC targets on connect", () => {
    const socket = new FakeSocket();
    registerSessionRpcHandlers({
      sessionId: "sess_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      handlers: noopHandlers(),
    });

    socket.trigger("connect");

    const targets = socket.emitted.filter((e) => e.event === "rpc-register").map((e) => e.payload);
    expect(targets).toEqual(
      expect.arrayContaining([
        { target: "s:sess_1:message" },
        { target: "s:sess_1:interrupt" },
        { target: "s:sess_1:takeControl" },
        { target: "s:sess_1:setMode" },
        { target: "s:sess_1:perm.answer" },
        { target: "s:sess_1:stop" },
      ]),
    );
  });

  it("registers immediately if the socket is already connected", () => {
    const socket = new FakeSocket();
    socket.connected = true;
    registerSessionRpcHandlers({
      sessionId: "sess_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      handlers: noopHandlers(),
    });

    expect(socket.emitted.filter((e) => e.event === "rpc-register")).toHaveLength(6);
  });

  it("decrypts params, runs the matching handler, and seals a valid result", async () => {
    const socket = new FakeSocket();
    const handlers = noopHandlers();
    registerSessionRpcHandlers({
      sessionId: "sess_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      handlers,
    });

    const envelope = createEnvelope("user", { t: "text", md: "hello" });
    const params = seal({ envelope }, DEK);
    const response = await callAndAwaitAck(socket, "message", params);

    expect(handlers.message).toHaveBeenCalledExactlyOnceWith({ envelope });
    expect(open(response, DEK)).toEqual({ queued: true });
  });

  it("routes the dotted 'perm.answer' method to handlers.permAnswer", async () => {
    const socket = new FakeSocket();
    const handlers = noopHandlers();
    registerSessionRpcHandlers({
      sessionId: "sess_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      handlers,
    });

    const params = seal({ reqId: "req_1", decision: { kind: "deny", message: "no" } }, DEK);
    const response = await callAndAwaitAck(socket, "perm.answer", params);

    expect(handlers.permAnswer).toHaveBeenCalledExactlyOnceWith({
      reqId: "req_1",
      decision: { kind: "deny", message: "no" },
    });
    expect(open(response, DEK)).toEqual({ ok: true });
  });

  it("handles interrupt/takeControl/setMode with their own param shapes", async () => {
    const socket = new FakeSocket();
    const handlers = noopHandlers();
    registerSessionRpcHandlers({
      sessionId: "sess_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      handlers,
    });

    await callAndAwaitAck(socket, "interrupt", seal({}, DEK));
    expect(handlers.interrupt).toHaveBeenCalledOnce();

    await callAndAwaitAck(socket, "takeControl", seal({}, DEK));
    expect(handlers.takeControl).toHaveBeenCalledOnce();

    const modeResponse = await callAndAwaitAck(socket, "setMode", seal({ mode: "plan" }, DEK));
    expect(handlers.setMode).toHaveBeenCalledExactlyOnceWith({ mode: "plan" });
    expect(open(modeResponse, DEK)).toEqual({ ok: true });
  });

  it("routes 'stop' to handlers.stop with its force param", async () => {
    const socket = new FakeSocket();
    const handlers = noopHandlers();
    registerSessionRpcHandlers({
      sessionId: "sess_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      handlers,
    });

    const response = await callAndAwaitAck(socket, "stop", seal({ force: true }, DEK));

    expect(handlers.stop).toHaveBeenCalledExactlyOnceWith({ force: true });
    expect(open(response, DEK)).toEqual({ ok: true });
  });

  it("replies with a sealed error for an unknown method", async () => {
    const socket = new FakeSocket();
    registerSessionRpcHandlers({
      sessionId: "sess_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      handlers: noopHandlers(),
    });

    const response = await callAndAwaitAck(socket, "nonsense", seal({}, DEK));
    expect(open(response, DEK)).toEqual({ ok: false, error: "unknown-method" });
  });

  it("replies with a sealed error when params is not a well-formed EncryptedBox", async () => {
    const socket = new FakeSocket();
    registerSessionRpcHandlers({
      sessionId: "sess_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      handlers: noopHandlers(),
    });

    const response = await callAndAwaitAck(socket, "interrupt", { not: "a box" });
    expect(open(response, DEK)).toEqual({ ok: false, error: "malformed-params" });
  });

  it("replies with a sealed error when params fail to decrypt under this session's dek", async () => {
    const socket = new FakeSocket();
    registerSessionRpcHandlers({
      sessionId: "sess_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      handlers: noopHandlers(),
    });

    const wrongDek = new Uint8Array(32).fill(9);
    const params = seal({ mode: "plan" }, wrongDek);
    const response = await callAndAwaitAck(socket, "setMode", params);
    expect(open(response, DEK)).toEqual({ ok: false, error: "decrypt-failed" });
  });

  it("replies with a sealed error when decrypted params fail the method's own schema", async () => {
    const socket = new FakeSocket();
    registerSessionRpcHandlers({
      sessionId: "sess_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      handlers: noopHandlers(),
    });

    const params = seal({ mode: "not-a-real-mode" }, DEK);
    const response = await callAndAwaitAck(socket, "setMode", params);
    expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
  });

  it("replies with a sealed error when the handler throws", async () => {
    const socket = new FakeSocket();
    const handlers = noopHandlers({
      interrupt: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    registerSessionRpcHandlers({
      sessionId: "sess_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      handlers,
    });

    const response = await callAndAwaitAck(socket, "interrupt", seal({}, DEK));
    expect(open(response, DEK)).toEqual({ ok: false, error: "handler-error" });
  });

  it("replies with a sealed error when the handler's result fails its own schema", async () => {
    const socket = new FakeSocket();
    const handlers = noopHandlers({
      interrupt: vi.fn(async () => ({ ok: "not-a-boolean" }) as unknown as { ok: boolean }),
    });
    registerSessionRpcHandlers({
      sessionId: "sess_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      handlers,
    });

    const response = await callAndAwaitAck(socket, "interrupt", seal({}, DEK));
    expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-result" });
  });

  it("stop() removes this module's listeners from the socket", () => {
    const socket = new FakeSocket();
    const handle = registerSessionRpcHandlers({
      sessionId: "sess_1",
      dek: DEK,
      socket: socket as unknown as import("socket.io-client").Socket,
      handlers: noopHandlers(),
    });

    expect(socket.handlers.get("rpc-request")?.length).toBe(1);
    handle.stop();
    expect(socket.handlers.get("rpc-request")?.length).toBe(0);
    expect(socket.handlers.get("connect")?.length).toBe(0);
  });
});
