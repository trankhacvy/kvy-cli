/**
 * apiSocket — singleton, user-scoped WebSocket client (design §9.1, §4.3).
 *
 * Ported from Happy's `happy-app/sources/sync/apiSocket.ts`: one Socket.IO
 * connection carrying the read-only `update`/`ephemeral` event stream (all
 * writes go over HTTP — ⚠ DELTA D1, see falcon-system-design.md §4.3/§9.1).
 * Two deltas from Happy's React Native original:
 *
 *  - `app-state` ("active" | "background") is derived from
 *    `document.visibilitychange` instead of React Native's `AppState` module
 *    (see `visibility.ts`) — it feeds the server's push-suppression logic
 *    (design §6.4: "skip if any user-scoped connection reports `app-state:
 *    active` and has the session's room joined").
 *  - Reconnection is Socket.IO's own infinite-retry engine
 *    (`reconnectionAttempts: Infinity`, see `socket-factory.ts`) rather than a
 *    hand-rolled timer: it already implements exponential backoff + jitter,
 *    and its `auth` option, given as a callback, is re-evaluated on *every*
 *    (re)connection attempt — so the handshake always carries the current
 *    token + app-state, closing the server's auth-in-middleware race window
 *    (`P1-1.1-server-realtime`'s `socket.ts`) on every reconnect, not just
 *    the first connect.
 *
 * Testable in isolation (plan.md 1.6: "the client module itself, its
 * reconnect/backoff state machine, and its unit tests can be built and
 * verified in isolation now against the wire contract"): `createApiSocket()`
 * takes an injectable `SocketFactory` + `VisibilitySource` so unit tests can
 * swap in in-memory fakes instead of a real Socket.IO connection and a real
 * `document` — mirrors `crypto/client.ts`'s `WorkerLike` split.
 */
import type { EncryptedBox, Ephemeral, Update } from "@falcon/wire";
import { EphemeralSchema, UpdateSchema } from "@falcon/wire";

export type AppState = "active" | "background";

/** apiSocket is always user-scoped (design §9.1) — session/machine-scoped
 * sockets belong to the CLI/daemon, not the web app. */
export type ClientType = "user-scoped";

export interface ApiSocketAuth {
  token: string;
  clientType: ClientType;
  appState: AppState;
}

/**
 * Minimal surface this module needs from a Socket.IO client socket — narrow
 * enough for tests to provide an in-memory double instead of a real
 * connection. A real `socket.io-client` `Socket` satisfies this structurally
 * (see `socket-factory.ts`); no wrapping required.
 */
export interface SocketLike {
  readonly connected: boolean;
  connect(): void;
  disconnect(): void;
  on(event: string, handler: (...args: never[]) => void): void;
  off(event: string, handler?: (...args: never[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

/** Called once per `connect()`; `getAuth` is read again by Socket.IO before
 * every (re)connection attempt (see socket-factory.ts's `auth` callback). */
export type SocketFactory = (getAuth: () => ApiSocketAuth) => SocketLike;

/** Abstracts "is the tab visible" so apiSocket doesn't touch `document`
 * directly — keeps it testable and safe under Next's static-export
 * prerendering (Node, no `document`). See `visibility.ts` for the real one. */
export interface VisibilitySource {
  currentState(): AppState;
  subscribe(handler: (state: AppState) => void): () => void;
}

type ApiSocketEventMap = {
  update: Update;
  ephemeral: Ephemeral;
  /** Fires once per *re*connect — not the initial connect. This is the
   * signal the sync engine invalidates every Query on (design §9.1: "reconnect
   * ⇒ invalidate all queries"; plan.md 8.1: `apiSocket.on('reconnect', () =>
   * queryClient.invalidateQueries())`). */
  reconnect: undefined;
  connect: undefined;
  disconnect: undefined;
};

type Listener<T> = (payload: T) => void;
// Storage type for the heterogeneous listener sets below — casts happen only
// at the `on`/`off`/`emit` boundary, never inside the class body.
type ErasedListener = (payload: never) => void;

/** Ack payload for an `rpc-call` (design §4.4, server's `rpcHandler.ts`):
 * `ok: false` covers everything from "bad params" through "target offline"
 * to "target died mid-call" — the relay always resolves the ack, it never
 * lets a call hang past its own 30s cap. Never thrown as an error by
 * `rpcCall` below; callers branch on `.ok`. */
export type RpcCallResult = { ok: true; result: EncryptedBox } | { ok: false; error: string };

// Comfortably above the server's own 30s `rpc-call` timeout (design §4.4) so
// a well-behaved server's own `{ok:false, error:"..."}` ack always wins the
// race — this is purely a last-resort guard against an ack that never
// arrives at all (e.g. the transport drops the response frame).
const RPC_CALL_CLIENT_TIMEOUT_MS = 35_000;

function isRpcCallResult(value: unknown): value is RpcCallResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof (value as { ok: unknown }).ok === "boolean"
  );
}

export interface ApiSocket {
  /** Connect (or reconnect with a new token — e.g. after re-auth). Idempotent
   * no-op if already connected with this exact token. */
  connect(token: string): void;
  /** Tear down the connection and stop reconnecting (e.g. logout). Safe to
   * call when already disconnected. */
  disconnect(): void;
  isConnected(): boolean;
  /** Current reported app-state ("active" unless the tab is hidden). */
  appState(): AppState;
  on<K extends keyof ApiSocketEventMap>(
    event: K,
    handler: Listener<ApiSocketEventMap[K]>,
  ): () => void;
  off<K extends keyof ApiSocketEventMap>(event: K, handler: Listener<ApiSocketEventMap[K]>): void;
  /** Calls a machine/session RPC method over the WS `rpc-call` transport
   * (design §4.4: `target` is `m:<machineId>:<method>` or
   * `s:<sessionId>:<method>`; `params` is always an `EncryptedBox` — the
   * relay forwards opaque bytes). Never rejects: no live socket, or an ack
   * that never arrives, resolves `{ok:false}` the same as a server-reported
   * failure — callers always branch on `.ok`, never on a caught exception. */
  rpcCall(target: string, method: string, params: EncryptedBox): Promise<RpcCallResult>;
}

export function createApiSocket(
  socketFactory: SocketFactory,
  visibility: VisibilitySource,
): ApiSocket {
  const listeners = new Map<keyof ApiSocketEventMap, Set<ErasedListener>>();
  function on<K extends keyof ApiSocketEventMap>(
    event: K,
    handler: Listener<ApiSocketEventMap[K]>,
  ): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler as ErasedListener);
    return () => {
      listeners.get(event)?.delete(handler as ErasedListener);
    };
  }
  function off<K extends keyof ApiSocketEventMap>(
    event: K,
    handler: Listener<ApiSocketEventMap[K]>,
  ): void {
    listeners.get(event)?.delete(handler as ErasedListener);
  }
  function emit<K extends keyof ApiSocketEventMap>(event: K, payload: ApiSocketEventMap[K]): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const handler of set) (handler as Listener<ApiSocketEventMap[K]>)(payload);
  }

  let socket: SocketLike | null = null;
  let token: string | null = null;
  let appState: AppState = visibility.currentState();
  let hasConnectedBefore = false;
  let unsubscribeVisibility: (() => void) | null = null;

  function handleConnect(): void {
    if (hasConnectedBefore) {
      emit("reconnect", undefined);
    }
    hasConnectedBefore = true;
    emit("connect", undefined);
  }

  function handleDisconnect(): void {
    emit("disconnect", undefined);
  }

  function handleUpdate(raw: unknown): void {
    const parsed = UpdateSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("apiSocket: dropped a malformed `update` payload", parsed.error);
      return;
    }
    emit("update", parsed.data);
  }

  function handleEphemeral(raw: unknown): void {
    const parsed = EphemeralSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("apiSocket: dropped a malformed `ephemeral` payload", parsed.error);
      return;
    }
    emit("ephemeral", parsed.data);
  }

  function teardown(): void {
    if (socket) {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("update", handleUpdate);
      socket.off("ephemeral", handleEphemeral);
      socket.disconnect();
      socket = null;
    }
    unsubscribeVisibility?.();
    unsubscribeVisibility = null;
    token = null;
    hasConnectedBefore = false;
  }

  return {
    connect(nextToken: string): void {
      if (socket && token === nextToken) return; // already connecting/connected with this token
      teardown();
      token = nextToken;
      appState = visibility.currentState(); // pick up any change while disconnected
      unsubscribeVisibility = visibility.subscribe((next) => {
        appState = next;
        // Only the *current* connection needs telling — the next connect/
        // reconnect attempt already reads `appState` fresh via `getAuth`.
        socket?.emit("app-state", { state: appState });
      });
      const nextSocket = socketFactory(() => ({
        token: token as string,
        clientType: "user-scoped",
        appState,
      }));
      nextSocket.on("connect", handleConnect);
      nextSocket.on("disconnect", handleDisconnect);
      nextSocket.on("update", handleUpdate);
      nextSocket.on("ephemeral", handleEphemeral);
      socket = nextSocket;
      socket.connect();
    },
    disconnect(): void {
      teardown();
    },
    isConnected(): boolean {
      return socket?.connected ?? false;
    },
    appState(): AppState {
      return appState;
    },
    on,
    off,
    rpcCall(target, method, params) {
      return new Promise<RpcCallResult>((resolve) => {
        if (!socket) {
          resolve({ ok: false, error: "not-connected" });
          return;
        }
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ ok: false, error: "timeout" });
        }, RPC_CALL_CLIENT_TIMEOUT_MS);
        // A real socket.io-client socket treats a trailing function argument
        // as the ack callback natively — no extra API surface needed on
        // `SocketLike` beyond the `...args: unknown[]` it already has.
        socket.emit("rpc-call", { target, method, params }, (response: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(
            isRpcCallResult(response) ? response : { ok: false, error: "malformed-response" },
          );
        });
      });
    },
  };
}
