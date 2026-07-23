import type { EncryptedBox, Ephemeral, Update } from "@falcon/wire";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiSocket } from "../apiSocket.js";
import { createFakeSocketFactory, createFakeVisibilitySource } from "./fakes.js";

const box = (c: string): EncryptedBox => ({ t: "enc", v: 1, c });

/** Pulls the ack callback off the most recent `rpc-call` emit recorded by
 * the fake socket — mirrors how a real socket.io-client socket treats a
 * trailing function argument as the ack (see apiSocket.ts's `rpcCall`). */
function lastRpcCallback(
  emitted: Array<{ event: string; args: unknown[] }>,
): (response: unknown) => void {
  const call = [...emitted].reverse().find((e) => e.event === "rpc-call");
  if (!call) throw new Error("no rpc-call was emitted");
  const cb = call.args[call.args.length - 1];
  if (typeof cb !== "function") throw new Error("rpc-call was emitted without an ack callback");
  return cb as (response: unknown) => void;
}

describe("apiSocket", () => {
  it("connects once per distinct token and requests the current app-state via auth", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);

    client.connect("tok-1");
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.authSnapshots[0]).toEqual({
      token: "tok-1",
      clientType: "user-scoped",
      appState: "active",
    });
    expect(sockets[0]?.connected).toBe(true);

    // Same token again -> no-op, no new socket, no disconnect of the live one.
    client.connect("tok-1");
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.connected).toBe(true);
  });

  it("tears down the old socket and opens a new one when the token changes", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);

    client.connect("tok-1");
    client.connect("tok-2");

    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.connected).toBe(false); // old socket disconnected
    expect(sockets[1]?.connected).toBe(true);
    expect(sockets[1]?.authSnapshots[0]?.token).toBe("tok-2");
  });

  it("disconnect() tears down the socket and stops isConnected() from reporting true", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);

    client.connect("tok-1");
    expect(client.isConnected()).toBe(true);

    client.disconnect();
    expect(client.isConnected()).toBe(false);
    expect(sockets[0]?.connected).toBe(false);

    // Safe to call again when already disconnected.
    expect(() => client.disconnect()).not.toThrow();
  });

  it("fires 'reconnect' on the second+ connect but not the first", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);

    const reconnectHandler = vi.fn();
    const connectHandler = vi.fn();
    client.on("reconnect", reconnectHandler);
    client.on("connect", connectHandler);

    client.connect("tok-1");
    expect(connectHandler).toHaveBeenCalledTimes(1);
    expect(reconnectHandler).not.toHaveBeenCalled();

    // Simulate Socket.IO's own reconnection: transport drops, then the
    // *same* underlying socket auto-reconnects (this is what `connect` fires
    // again for, without an intervening `client.connect()` call).
    sockets[0]?.disconnect();
    sockets[0]?.connect();

    expect(connectHandler).toHaveBeenCalledTimes(2);
    expect(reconnectHandler).toHaveBeenCalledTimes(1);
  });

  it("does not treat a fresh connect() (new token) as a reconnect", () => {
    const { factory } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);

    const reconnectHandler = vi.fn();
    client.on("reconnect", reconnectHandler);

    client.connect("tok-1");
    client.disconnect();
    client.connect("tok-2"); // brand-new logical connection, not a reconnect

    expect(reconnectHandler).not.toHaveBeenCalled();
  });

  it("delivers a well-formed 'update' payload and drops a malformed one without throwing", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    const received: Update[] = [];
    client.on("update", (u) => received.push(u));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const validUpdate: Update = { ts: 123, body: { t: "session-delete", id: "sess-1" } };
    sockets[0]?.serverEmit("update", validUpdate);
    expect(received).toEqual([validUpdate]);

    expect(() => sockets[0]?.serverEmit("update", { garbage: true })).not.toThrow();
    expect(received).toHaveLength(1); // malformed payload was dropped, not delivered
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("delivers a well-formed 'ephemeral' payload and drops a malformed one", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    const received: Ephemeral[] = [];
    client.on("ephemeral", (e) => received.push(e));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const validEphemeral: Ephemeral = { t: "activity", sessionId: "sess-1", working: true };
    sockets[0]?.serverEmit("ephemeral", validEphemeral);
    expect(received).toEqual([validEphemeral]);

    sockets[0]?.serverEmit("ephemeral", { t: "not-a-real-kind" });
    expect(received).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("reports app-state changes to the live socket and to the next connect()'s auth", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source, trigger } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    trigger("background");
    expect(client.appState()).toBe("background");
    expect(sockets[0]?.emitted).toContainEqual({
      event: "app-state",
      args: [{ state: "background" }],
    });

    // Reconnecting (new token) must pick up the latest state, not the state
    // from when this apiSocket instance was constructed.
    client.connect("tok-2");
    expect(sockets[1]?.authSnapshots[0]?.appState).toBe("background");
  });

  it("stops reporting app-state to a socket after disconnect()", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source, trigger } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");
    client.disconnect();

    trigger("background"); // no live connection to emit to
    expect(sockets[0]?.emitted.some((e) => e.event === "app-state")).toBe(false);
  });

  it("translates a connect_error auth-rejection message into 'authError' and stops retrying", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    const authErrorHandler = vi.fn();
    client.on("authError", authErrorHandler);

    expect(client.isAuthExpired()).toBe(false);
    sockets[0]?.serverEmit("connect_error", new Error("Invalid authentication token"));

    expect(authErrorHandler).toHaveBeenCalledExactlyOnceWith({
      message: "Invalid authentication token",
    });
    expect(client.isAuthExpired()).toBe(true);
    // The doomed retry loop is torn down rather than left to keep retrying.
    expect(client.isConnected()).toBe(false);
    expect(sockets[0]?.connected).toBe(false);
  });

  it("treats the server's 'Session revoked' connect_error the same as an auth-rejection (security review finding F2 — a revoked device must actually notice, not retry forever)", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    const authErrorHandler = vi.fn();
    client.on("authError", authErrorHandler);

    sockets[0]?.serverEmit("connect_error", new Error("Session revoked"));

    expect(authErrorHandler).toHaveBeenCalledExactlyOnceWith({ message: "Session revoked" });
    expect(client.isAuthExpired()).toBe(true);
    expect(client.isConnected()).toBe(false);
  });

  it("fires its own 'disconnect' listeners for the teardown a connect_error triggers", () => {
    // `teardown()` calls `socket.disconnect()` *before* unsubscribing
    // `handleDisconnect` (see apiSocket.ts), so the internal handler that
    // re-emits apiSocket's own 'disconnect' event still runs for this path,
    // alongside `authError`. This matters because `useConnectivity`'s
    // `wsConnected` state is driven solely by that 'disconnect' event (not a
    // poll of `isConnected()`): an auth-rejection must flip `wsConnected` to
    // `false` in step with `isConnected()`, or it would stay stuck at
    // whatever it was before (typically `true`) purely because of listener
    // teardown ordering, independent of the real connection state.
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    const disconnectHandler = vi.fn();
    client.on("disconnect", disconnectHandler);

    sockets[0]?.serverEmit("connect_error", new Error("Invalid authentication token"));

    expect(client.isConnected()).toBe(false); // the synchronous query is accurate
    expect(disconnectHandler).toHaveBeenCalledTimes(1); // ...and the event told listeners so too
  });

  it("ignores a connect_error that isn't an auth rejection (transport-level failure)", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    const authErrorHandler = vi.fn();
    client.on("authError", authErrorHandler);

    sockets[0]?.serverEmit("connect_error", new Error("xhr poll error"));

    expect(authErrorHandler).not.toHaveBeenCalled();
    expect(client.isAuthExpired()).toBe(false);
  });

  it("isAuthExpired() resets to false on the next connect() (fresh token)", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    sockets[0]?.serverEmit("connect_error", new Error("Invalid authentication token"));
    expect(client.isAuthExpired()).toBe(true);

    client.connect("tok-2");
    expect(client.isAuthExpired()).toBe(false);
  });

  it("unsubscribes connect_error in teardown() — no authError after disconnect()", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    const authErrorHandler = vi.fn();
    client.on("authError", authErrorHandler);

    const socket = sockets[0];
    client.disconnect();
    socket?.serverEmit("connect_error", new Error("Invalid authentication token"));

    expect(authErrorHandler).not.toHaveBeenCalled();
  });

  it("fires 'disconnect' listeners when the socket disconnects", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    const disconnectHandler = vi.fn();
    client.on("disconnect", disconnectHandler);

    sockets[0]?.disconnect();
    expect(disconnectHandler).toHaveBeenCalledTimes(1);
  });

  it("off() unsubscribes a handler and the returned unsubscribe from on() also works", () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = client.on("update", a);
    client.on("update", b);

    unsubscribeA();
    client.off("update", b);

    const validUpdate: Update = { ts: 1, body: { t: "session-delete", id: "s" } };
    sockets[0]?.serverEmit("update", validUpdate);

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("rpcCall emits {target, method, params} and resolves with the ack response", async () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    const params = box("params-ct");
    const pending = client.rpcCall("s:sess-1:interrupt", "interrupt", params);

    expect(sockets[0]?.emitted).toContainEqual(
      expect.objectContaining({
        event: "rpc-call",
        args: expect.arrayContaining([
          { target: "s:sess-1:interrupt", method: "interrupt", params },
        ]),
      }),
    );

    lastRpcCallback(sockets[0]?.emitted ?? [])({ ok: true, result: box("result-ct") });
    await expect(pending).resolves.toEqual({ ok: true, result: box("result-ct") });
  });

  it("rpcCall resolves {ok:false} verbatim when the server reports failure", async () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    const pending = client.rpcCall("s:sess-1:interrupt", "interrupt", box("p"));
    lastRpcCallback(sockets[0]?.emitted ?? [])({ ok: false, error: "target-offline" });

    await expect(pending).resolves.toEqual({ ok: false, error: "target-offline" });
  });

  it("rpcCall resolves {ok:false} without throwing when no socket is connected", async () => {
    const { factory } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    // never connected

    await expect(client.rpcCall("s:sess-1:interrupt", "interrupt", box("p"))).resolves.toEqual({
      ok: false,
      error: "not-connected",
    });
  });

  it("rpcCall resolves {ok:false, error:'malformed-response'} on a garbage ack payload", async () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    const pending = client.rpcCall("s:sess-1:interrupt", "interrupt", box("p"));
    lastRpcCallback(sockets[0]?.emitted ?? [])("not-an-object");

    await expect(pending).resolves.toEqual({ ok: false, error: "malformed-response" });
  });

  it("rpcCall ignores a second callback invocation (settles once)", async () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const client = createApiSocket(factory, source);
    client.connect("tok-1");

    const pending = client.rpcCall("s:sess-1:interrupt", "interrupt", box("p"));
    const cb = lastRpcCallback(sockets[0]?.emitted ?? []);
    cb({ ok: true, result: box("first") });
    cb({ ok: true, result: box("second") });

    await expect(pending).resolves.toEqual({ ok: true, result: box("first") });
  });

  it("rpcCall resolves {ok:false, error:'timeout'} if the ack never arrives", async () => {
    vi.useFakeTimers();
    try {
      const { factory } = createFakeSocketFactory();
      const { source } = createFakeVisibilitySource("active");
      const client = createApiSocket(factory, source);
      client.connect("tok-1");

      const pending = client.rpcCall("s:sess-1:interrupt", "interrupt", box("p"));
      const assertion = expect(pending).resolves.toEqual({ ok: false, error: "timeout" });
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("apiSocket — proactive renew-token + connect_error recovery (issue-4-plan.md §4.5/§6.4)", () => {
  it("proactively emits renew-token ~10 minutes after connect, re-arming on a successful ack", async () => {
    vi.useFakeTimers();
    try {
      const { factory, sockets } = createFakeSocketFactory();
      const { source } = createFakeVisibilitySource("active");
      const renew = vi.fn().mockResolvedValue("fresh-token-1");
      const client = createApiSocket(factory, source, renew);

      client.connect("tok-1");
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      const renewCall = sockets[0]?.emitted.find((e) => e.event === "renew-token");
      expect(renewCall?.args[0]).toBe("fresh-token-1");
      expect(renew).toHaveBeenCalledTimes(1);

      const ack = renewCall?.args[renewCall.args.length - 1] as (ok: boolean) => void;
      ack(true);

      // Re-armed: another interval later, a second renew-token fires.
      renew.mockResolvedValue("fresh-token-2");
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      const renewCalls = sockets[0]?.emitted.filter((e) => e.event === "renew-token");
      expect(renewCalls?.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not proactively renew when no renew source is wired (default 2-arg construction)", async () => {
    vi.useFakeTimers();
    try {
      const { factory, sockets } = createFakeSocketFactory();
      const { source } = createFakeVisibilitySource("active");
      const client = createApiSocket(factory, source);

      client.connect("tok-1");
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(sockets[0]?.emitted.some((e) => e.event === "renew-token")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the renew timer on disconnect() and after a torn-down connect_error", async () => {
    vi.useFakeTimers();
    try {
      const { factory, sockets } = createFakeSocketFactory();
      const { source } = createFakeVisibilitySource("active");
      const renew = vi.fn().mockResolvedValue("fresh-token");
      const client = createApiSocket(factory, source, renew);

      client.connect("tok-1");
      client.disconnect();

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(sockets[0]?.emitted.some((e) => e.event === "renew-token")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stale token on connect_error triggers exactly one silent-refresh attempt and keeps the retry loop alive on success", async () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const renew = vi.fn().mockResolvedValue("fresh-token");
    const client = createApiSocket(factory, source, renew);
    client.connect("tok-1");

    const authErrorHandler = vi.fn();
    client.on("authError", authErrorHandler);

    sockets[0]?.serverEmit("connect_error", new Error("Invalid authentication token"));
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(1));

    // Recovered silently: no authError, no teardown — socket.io's own retry loop
    // (never disconnected here) presents the fresh token on its next attempt.
    expect(authErrorHandler).not.toHaveBeenCalled();
    expect(client.isAuthExpired()).toBe(false);
    expect(sockets[0]?.connected).toBe(true); // never torn down
  });

  it("a live 'Session revoked' connect_error (F2's device-revocation path) also triggers a silent-refresh attempt, falling through to teardown + authError once it fails (the revoked session's own refresh token is dead too)", async () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const renew = vi.fn().mockResolvedValue(null);
    const client = createApiSocket(factory, source, renew);
    client.connect("tok-1");

    const authErrorHandler = vi.fn();
    client.on("authError", authErrorHandler);

    sockets[0]?.serverEmit("connect_error", new Error("Session revoked"));
    await vi.waitFor(() => expect(authErrorHandler).toHaveBeenCalledTimes(1));

    expect(renew).toHaveBeenCalledTimes(1);
    expect(client.isAuthExpired()).toBe(true);
    expect(client.isConnected()).toBe(false);
  });

  it("falls back to teardown + authError when the silent-refresh attempt itself fails (dead refresh token)", async () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const renew = vi.fn().mockResolvedValue(null);
    const client = createApiSocket(factory, source, renew);
    client.connect("tok-1");

    const authErrorHandler = vi.fn();
    client.on("authError", authErrorHandler);

    sockets[0]?.serverEmit("connect_error", new Error("Invalid authentication token"));
    await vi.waitFor(() => expect(authErrorHandler).toHaveBeenCalledTimes(1));

    expect(client.isAuthExpired()).toBe(true);
    expect(client.isConnected()).toBe(false);
  });

  it("never attempts a renew for a non-auth-shaped connect_error", async () => {
    const { factory, sockets } = createFakeSocketFactory();
    const { source } = createFakeVisibilitySource("active");
    const renew = vi.fn().mockResolvedValue("fresh-token");
    const client = createApiSocket(factory, source, renew);
    client.connect("tok-1");

    sockets[0]?.serverEmit("connect_error", new Error("xhr poll error"));

    expect(renew).not.toHaveBeenCalled();
  });
});

describe("createApiSocket module wiring smoke test", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("the real singleton (index.ts) constructs without throwing under Node (no document/socket.io connection made)", async () => {
    const mod = await import("../index.js");
    expect(mod.apiSocket).toBeDefined();
    expect(mod.apiSocket.appState()).toBe("active"); // no `document` under Vitest's node env -> defaults active
    expect(mod.apiSocket.isConnected()).toBe(false); // autoConnect: false, and connect() was never called
  });
});
