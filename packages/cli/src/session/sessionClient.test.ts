import { describe, expect, it, vi } from "vitest";
import type { TokenProvider } from "../auth/tokenProvider.js";
import type { Logger } from "../logger.js";
import type { SessionClientDeps } from "./sessionClient.js";
import { createSessionClientDeps, startSessionClient } from "./sessionClient.js";

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/** issue-4-plan.md §6.6: a fake `TokenProvider` that always resolves the same access
 * token, tracking `forceRefresh` calls so tests can assert on the connect_error path. */
function fakeTokenProvider(
  accessToken: string | null = "test-token",
): TokenProvider & { forceRefreshCalls: number } {
  const state = {
    forceRefreshCalls: 0,
    async getAccessToken() {
      return accessToken;
    },
    async forceRefresh() {
      state.forceRefreshCalls += 1;
      return accessToken;
    },
    isDead: false,
  };
  return state;
}

/** Minimal fake standing in for a socket.io-client `Socket` (mirrors machineClient.test.ts). */
class FakeSocket {
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  emitted: {
    event: string;
    payload: unknown;
    volatile: boolean;
    ack?: (...args: unknown[]) => void;
  }[] = [];
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

  emit(event: string, payload: unknown, ack?: (...args: unknown[]) => void): void {
    this.emitted.push({ event, payload, volatile: false, ack });
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
    { serverUrl: "http://localhost:4000", tokenProvider: fakeTokenProvider(), sessionId: "sess_1" },
    {
      ioFactory: vi.fn(),
      logger: silentLogger(),
      aliveIntervalMs: 20_000,
      renewIntervalMs: 10 * 60 * 1000,
      getWorking: () => false,
      ...overrides,
    },
  );
}

describe("startSessionClient", () => {
  it("opens the socket with clientType session-scoped and returns a handle", async () => {
    const fakeSocket = new FakeSocket();
    const ioFactory = vi.fn().mockReturnValue(fakeSocket);
    const deps = buildDeps({ ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"] });

    const handle = startSessionClient(deps);

    expect(ioFactory).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:4000",
      expect.objectContaining({ path: "/v1/stream", transports: ["websocket"] }),
    );
    // issue-4-plan.md §6.6: `auth` is now an async callback (asks the tokenProvider for
    // a currently-valid token on every handshake) rather than a static object.
    const [, socketOpts] = ioFactory.mock.calls[0] as [
      string,
      { auth: (cb: (d: unknown) => void) => void },
    ];
    const authResult = await new Promise((resolve) => socketOpts.auth(resolve));
    expect(authResult).toEqual({
      token: "test-token",
      clientType: "session-scoped",
      sessionId: "sess_1",
    });
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

  it("forces a token refresh on an auth-shaped connect_error (issue-4-plan.md §6.6)", async () => {
    const fakeSocket = new FakeSocket();
    const ioFactory = vi.fn().mockReturnValue(fakeSocket);
    const tokenProvider = fakeTokenProvider();
    const deps = buildDeps({
      ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"],
      tokenProvider,
    });

    startSessionClient(deps);
    fakeSocket.trigger("connect_error", new Error("Invalid authentication token"));
    await vi.waitFor(() => expect(tokenProvider.forceRefreshCalls).toBe(1));

    // A non-auth-shaped error must NOT trigger a refresh.
    fakeSocket.trigger("connect_error", new Error("xhr poll error"));
    expect(tokenProvider.forceRefreshCalls).toBe(1);
  });

  it("proactively renews the same live socket via renew-token, re-arming on success", async () => {
    vi.useFakeTimers();
    try {
      const fakeSocket = new FakeSocket();
      const ioFactory = vi.fn().mockReturnValue(fakeSocket);
      const tokenProvider = fakeTokenProvider("fresh-token");
      const deps = buildDeps({
        ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"],
        tokenProvider,
        renewIntervalMs: 60_000,
      });

      startSessionClient(deps);
      fakeSocket.trigger("connect");

      await vi.advanceTimersByTimeAsync(60_000);
      const renewCall = fakeSocket.emitted.find((e) => e.event === "renew-token");
      expect(renewCall?.payload).toBe("fresh-token");
      renewCall?.ack?.(true);

      // Re-armed: another interval later, a second renew-token fires.
      await vi.advanceTimersByTimeAsync(60_000);
      const renewCalls = fakeSocket.emitted.filter((e) => e.event === "renew-token");
      expect(renewCalls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a warning instead of renewing when the token provider can't produce a token", async () => {
    vi.useFakeTimers();
    try {
      const fakeSocket = new FakeSocket();
      const ioFactory = vi.fn().mockReturnValue(fakeSocket);
      const warn = vi.fn();
      const deps = buildDeps({
        ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"],
        tokenProvider: fakeTokenProvider(null),
        renewIntervalMs: 60_000,
        logger: { ...silentLogger(), warn },
      });

      startSessionClient(deps);
      fakeSocket.trigger("connect");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("could not obtain an access token"),
      );
      expect(fakeSocket.emitted.some((e) => e.event === "renew-token")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // auth-ux-overhaul-fix-plan.md Fix 7: the session socket joins `user:${accountId}` like
  // every other connection, so a key request raised on another device already lands here —
  // it was simply never listened for before this fix.
  it("fires onKeyRequest for a valid key-request ephemeral", () => {
    const fakeSocket = new FakeSocket();
    const ioFactory = vi.fn().mockReturnValue(fakeSocket);
    const onKeyRequest = vi.fn();
    const deps = buildDeps({
      ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"],
      onKeyRequest,
    });

    startSessionClient(deps);
    fakeSocket.trigger("ephemeral", { t: "key-request", ephPub: "eph-1", label: "Chrome on Mac" });

    expect(onKeyRequest).toHaveBeenCalledExactlyOnceWith({ label: "Chrome on Mac" });
  });

  it("does not fire onKeyRequest for a non-key-request ephemeral", () => {
    const fakeSocket = new FakeSocket();
    const ioFactory = vi.fn().mockReturnValue(fakeSocket);
    const onKeyRequest = vi.fn();
    const deps = buildDeps({
      ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"],
      onKeyRequest,
    });

    startSessionClient(deps);
    fakeSocket.trigger("ephemeral", { t: "activity", sessionId: "sess_1", working: true });

    expect(onKeyRequest).not.toHaveBeenCalled();
  });

  it("does not fire onKeyRequest, and does not throw, for an unparsable ephemeral payload", () => {
    const fakeSocket = new FakeSocket();
    const ioFactory = vi.fn().mockReturnValue(fakeSocket);
    const onKeyRequest = vi.fn();
    const deps = buildDeps({
      ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"],
      onKeyRequest,
    });

    startSessionClient(deps);
    expect(() => fakeSocket.trigger("ephemeral", { garbage: true })).not.toThrow();

    expect(onKeyRequest).not.toHaveBeenCalled();
  });

  it("stops the renew timer on stop() and on disconnect", async () => {
    vi.useFakeTimers();
    try {
      const fakeSocket = new FakeSocket();
      const ioFactory = vi.fn().mockReturnValue(fakeSocket);
      const deps = buildDeps({
        ioFactory: ioFactory as unknown as SessionClientDeps["ioFactory"],
        renewIntervalMs: 60_000,
      });

      const handle = startSessionClient(deps);
      fakeSocket.trigger("connect");
      handle.stop();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(fakeSocket.emitted.some((e) => e.event === "renew-token")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
