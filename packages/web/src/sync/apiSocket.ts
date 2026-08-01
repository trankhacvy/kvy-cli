/**
 * apiSocket — singleton, user-scoped WebSocket client (design §9.1, §4.3).
 *
 * Ported from Happy's `happy-app/sources/sync/apiSocket.ts`: one Socket.IO
 * connection carrying the read-only `update`/`ephemeral` event stream (all
 * writes go over HTTP — ⚠ DELTA D1, see kvy-system-design.md §4.3/§9.1).
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
import type { EncryptedBox, Ephemeral, Update } from "@kvy/wire";
import { EphemeralSchema, UpdateSchema } from "@kvy/wire";

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
  /** Fires when a (re)connection attempt is rejected by the server (e.g. an
   * expired/invalid token) — distinct from a transport-level disconnect,
   * which infinite-retry can genuinely recover from on its own
   * (bug-fix-plan.md #10). */
  authError: { message: string };
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
  /** True once the server has rejected a (re)connection attempt as an
   * auth failure (`authError`) and stays true until the next successful
   * `connect(token)` call with a fresh token — a synchronous query
   * mirroring `isConnected()`, so callers (e.g. `useConnectivity`) can read
   * the current state at mount, not just react to the event going forward. */
  isAuthExpired(): boolean;
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

/**
 * issue-4-plan.md §4.5/§6.4: attempts one silent refresh (via the stored refresh
 * token) and returns the fresh access token, or `null` if the refresh token is
 * dead/absent. Kept as an injectable dependency (mirrors `SocketFactory`/
 * `VisibilitySource`) rather than importing `lib/session.ts`'s `silentRefresh`
 * directly, so this module stays testable with a fake instead of touching
 * `localStorage`/making a real HTTP call — `sync/index.ts` wires the real one.
 */
export type TokenRenewSource = () => Promise<string | null>;

// Comfortably inside the 15-minute access-token TTL (Phase 6) — same fixed-interval
// pattern (not exp-derived) as the CLI's `machineClient.ts`/`sessionClient.ts`
// `armRenewTimer`, for the same reason: simpler than decoding the token's own `exp`
// claim here, and still leaves 5 minutes of margin either way.
const RENEW_INTERVAL_MS = 10 * 60 * 1000;

export function createApiSocket(
  socketFactory: SocketFactory,
  visibility: VisibilitySource,
  renew?: TokenRenewSource,
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
  let authExpired = false;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  // Guards against overlapping renew attempts — a proactive timer fire racing a
  // connect_error (or two connect_errors in a row) must only ever have one
  // `renew()` call in flight at a time.
  let renewInFlight = false;

  function stopRenewTimer(): void {
    if (renewTimer) {
      clearTimeout(renewTimer);
      renewTimer = null;
    }
  }

  // issue-4-plan.md §4.5/§6.4: re-authenticates the SAME live socket well before the
  // access token it originally handshook with expires, via the server's in-band
  // `renew-token` event — no disconnect, no visible reconnect.
  function armRenewTimer(): void {
    stopRenewTimer();
    if (!renew) return; // no renew source wired (e.g. a test double) — proactive renewal is simply off
    renewTimer = setTimeout(async () => {
      if (!socket || renewInFlight) return;
      renewInFlight = true;
      try {
        const fresh = await renew();
        if (!fresh || !socket) return; // dead refresh token, or torn down while awaiting
        token = fresh;
        socket.emit("renew-token", fresh, (ok: boolean) => {
          if (ok) armRenewTimer();
          else console.warn("apiSocket: renew-token was rejected by the server");
        });
      } finally {
        renewInFlight = false;
      }
    }, RENEW_INTERVAL_MS);
  }

  function handleConnect(): void {
    if (hasConnectedBefore) {
      emit("reconnect", undefined);
    }
    hasConnectedBefore = true;
    emit("connect", undefined);
    armRenewTimer();
  }

  function handleDisconnect(): void {
    stopRenewTimer();
    emit("disconnect", undefined);
  }

  function handleConnectError(err: Error): void {
    // Socket.IO delivers the server's `io.use()` middleware `next(new
    // Error(...))` message verbatim (server's socket.ts: "Missing
    // authentication token" / "Invalid authentication token" / "Session
    // revoked" — this last one is exactly the F2 device-revocation path:
    // security-review remediation pass, found live while testing "the revoked
    // session's socket drops immediately" — the socket DID drop immediately,
    // but this regex used to only match the first two messages, so a
    // revoked-elsewhere tab's own automatic reconnect kept silently retrying
    // the same doomed handshake forever instead of ever reaching the
    // silentRefresh-then-teardown path below. Widened to match the CLI's own
    // `machineClient.ts`/`sessionClient.ts` pattern, which already had it
    // right) — anything else (e.g. a transport-level failure to even reach
    // the server) is left for the infinite-retry engine to keep handling on
    // its own.
    if (!/authentication token|Session revoked/i.test(err.message)) return;

    // issue-4-plan.md §4.5/§6.4: a single silent-refresh attempt before giving up —
    // the access token presented at this handshake may simply be stale (not
    // necessarily revoked). No `renew` source wired (or already one in flight)
    // falls straight through to the same fail-closed teardown as before.
    if (renew && !renewInFlight) {
      renewInFlight = true;
      void renew()
        .then((fresh) => {
          if (fresh) {
            // Update the token so socket.io's own already-running automatic retry
            // (never torn down here) presents it on the next attempt — no
            // manual reconnect() call needed, `getAuth` reads `token` fresh
            // every time (socket-factory.ts).
            token = fresh;
            return;
          }
          authExpired = true;
          emit("authError", { message: err.message });
          teardown();
        })
        .finally(() => {
          renewInFlight = false;
        });
      return;
    }

    authExpired = true;
    emit("authError", { message: err.message });
    // The retry loop cannot succeed without a fresh token —
    // `reconnectionAttempts: Infinity` (socket-factory.ts) has no way to know
    // the failure is permanent on its own, so stop it here rather than let it
    // keep retrying a handshake that's doomed to be rejected the same way
    // every time.
    teardown();
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
    stopRenewTimer();
    if (socket) {
      // `disconnect()` must run *before* `handleDisconnect` is unsubscribed:
      // a real socket.io-client socket (and the fake test double) fires its
      // 'disconnect' event synchronously from this call, and apiSocket's own
      // 'disconnect' event (consumed by e.g. `useConnectivity`'s
      // `wsConnected`) is only ever re-emitted from that handler. Tearing
      // down listeners first — the previous order — silently swallowed
      // 'disconnect' for every path that routes through `teardown()`
      // (`disconnect()` itself and `handleConnectError`'s auth-rejection
      // path alike), leaving `wsConnected` stuck at its last value.
      socket.disconnect();
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("update", handleUpdate);
      socket.off("ephemeral", handleEphemeral);
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
      authExpired = false; // a fresh connect() attempt starts optimistic; handleConnectError flips this if rejected again
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
      nextSocket.on("connect_error", handleConnectError);
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
    isAuthExpired(): boolean {
      return authExpired;
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
