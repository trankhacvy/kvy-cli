import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import type { SessionClientDeps } from "./sessionClient.js";
import { createSessionClientDeps, startSessionClient } from "./sessionClient.js";

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/** Minimal fake standing in for a socket.io-client `Socket` (mirrors machineClient.test.ts). */
class FakeSocket {
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  emitted: { event: string; payload: unknown; volatile: boolean }[] = [];
  closed = false;
  volatile = {
    emit: (event: string, payload: unknown) => {
      this.emitted.push({ event, payload, volatile: true });
    },
  };

  on(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload, volatile: false });
  }

  close(): void {
    this.closed = true;
  }

  connect(): void {
    // no-op stand-in for socket.io-client's manual-reconnect escape hatch
  }

  trigger(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

function buildDeps(overrides: Partial<SessionClientDeps> = {}): SessionClientDeps {
  return createSessionClientDeps(
    { serverUrl: "http://localhost:4000", token: "test-token", sessionId: "sess_1" },
    {
      ioFactory: vi.fn(),
      logger: silentLogger(),
      aliveIntervalMs: 20_000,
      getWorking: () => false,
      ...overrides,
    },
  );
}

describe("startSessionClient", () => {
  it("opens the socket with clientType session-scoped and returns a handle", () => {
    const fakeSocket = new FakeSocket();
    const ioFactory = vi.fn().mockReturnValue(fakeSocket);
    const deps = buildDeps({ ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"] });

    const handle = startSessionClient(deps);

    expect(ioFactory).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:4000",
      expect.objectContaining({
        path: "/v1/stream",
        transports: ["websocket"],
        auth: { token: "test-token", clientType: "session-scoped", sessionId: "sess_1" },
      }),
    );
    expect(handle.connected).toBe(false);
  });

  it("emits alive volatilely on connect, carrying the injected working flag", () => {
    const fakeSocket = new FakeSocket();
    const ioFactory = vi.fn().mockReturnValue(fakeSocket);
    const deps = buildDeps({
      ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"],
      getWorking: () => true,
    });

    const handle = startSessionClient(deps);
    fakeSocket.trigger("connect");

    expect(handle.connected).toBe(true);
    expect(fakeSocket.emitted).toContainEqual({
      event: "alive",
      payload: { sessionId: "sess_1", working: true },
      volatile: true,
    });
  });

  it("re-emits alive on the configured interval, reading getWorking fresh each time", async () => {
    vi.useFakeTimers();
    try {
      const fakeSocket = new FakeSocket();
      const ioFactory = vi.fn().mockReturnValue(fakeSocket);
      let working = false;
      const deps = buildDeps({
        ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"],
        aliveIntervalMs: 20_000,
        getWorking: () => working,
      });

      startSessionClient(deps);
      fakeSocket.trigger("connect");
      const countAfterConnect = fakeSocket.emitted.length;

      working = true;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fakeSocket.emitted.length).toBe(countAfterConnect + 1);
      expect(fakeSocket.emitted.at(-1)).toEqual({
        event: "alive",
        payload: { sessionId: "sess_1", working: true },
        volatile: true,
      });

      await vi.advanceTimersByTimeAsync(20_000);
      expect(fakeSocket.emitted.length).toBe(countAfterConnect + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the alive timer and closes the socket on stop()", async () => {
    vi.useFakeTimers();
    try {
      const fakeSocket = new FakeSocket();
      const ioFactory = vi.fn().mockReturnValue(fakeSocket);
      const deps = buildDeps({ ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"] });

      const handle = startSessionClient(deps);
      fakeSocket.trigger("connect");

      handle.stop();
      expect(fakeSocket.closed).toBe(true);
      expect(handle.connected).toBe(false);

      const countAfterStop = fakeSocket.emitted.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fakeSocket.emitted.length).toBe(countAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the alive timer on disconnect and does not reconnect after stop()", async () => {
    vi.useFakeTimers();
    try {
      const fakeSocket = new FakeSocket();
      const ioFactory = vi.fn().mockReturnValue(fakeSocket);
      const deps = buildDeps({ ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"] });

      const handle = startSessionClient(deps);
      fakeSocket.trigger("connect");
      fakeSocket.trigger("disconnect", "transport close");

      expect(handle.connected).toBe(false);
      const countAfterDisconnect = fakeSocket.emitted.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fakeSocket.emitted.length).toBe(countAfterDisconnect);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls socket.connect() on disconnect (covers the io-server-disconnect case) unless stopped", () => {
    const fakeSocket = new FakeSocket();
    const connectSpy = vi.spyOn(fakeSocket, "connect");
    const ioFactory = vi.fn().mockReturnValue(fakeSocket);
    const deps = buildDeps({ ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"] });

    startSessionClient(deps);
    fakeSocket.trigger("connect");
    fakeSocket.trigger("disconnect", "io server disconnect");

    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it("does not call socket.connect() on disconnect after stop() was already called", () => {
    const fakeSocket = new FakeSocket();
    const connectSpy = vi.spyOn(fakeSocket, "connect");
    const ioFactory = vi.fn().mockReturnValue(fakeSocket);
    const deps = buildDeps({ ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"] });

    const handle = startSessionClient(deps);
    fakeSocket.trigger("connect");
    handle.stop();
    fakeSocket.trigger("disconnect", "io server disconnect");

    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("logs connect_error instead of failing silently", () => {
    const fakeSocket = new FakeSocket();
    const ioFactory = vi.fn().mockReturnValue(fakeSocket);
    const warn = vi.fn();
    const deps = buildDeps({
      ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"],
      logger: { ...silentLogger(), warn },
    });

    startSessionClient(deps);
    fakeSocket.trigger("connect_error", new Error("Invalid authentication token"));

    expect(warn).toHaveBeenCalledWith(
      "[session-client] connect error",
      expect.objectContaining({ error: "Invalid authentication token" }),
    );
  });
});
