/**
 * Session-scoped WS client for a Falcon session process.
 *
 * New code (plan.md §16 Phase 1.4 line 688: "`alive` keepalive emits (working
 * flag from fd3 thinking state) over WS"), structured to mirror the
 * already-built (but also unlanded) machine-scoped WS client
 * (`daemon/machineClient.ts`) per design §4.3/§8:
 *
 *  - Connects to the already-landed `/v1/stream` Socket.IO endpoint with
 *    `clientType: "session-scoped"` — the server-side handshake
 *    (`packages/server/src/app/socket.ts`) already requires `sessionId` for
 *    this client type and rooms the connection accordingly.
 *  - Emits the `alive` keepalive on a fixed interval, and immediately on
 *    every (re)connect so presence recovers without waiting a full tick.
 *    Wire shape matches design §4.3's `ClientEmit` variant `{ e: 'alive';
 *    sessionId; working }` — Socket.IO's own event name ("alive") carries
 *    the `e` discriminator, so the payload is just `{ sessionId, working }`.
 *    Sent via `socket.volatile.emit` (design §4.3: "volatile keepalive" —
 *    droppable, never queued for a disconnected/backpressured socket).
 *  - The `working` flag is NOT read from fd3 here. The real signal
 *    (thinking-state parsed off Claude's stdio fd3 stream, debounced) now
 *    lives in `claudeLocal.ts`'s `onThinkingChange` callback — merged into
 *    this branch's worktree, but there is not yet any call site that starts
 *    both `claudeLocal()` and this module together for the same session
 *    process: that's the still-unbuilt mode-loop/launcher orchestration
 *    (plan.md §16 "`loop.ts` port + `claudeLocalLauncher`/
 *    `claudeRemoteLauncher` orchestration"). This client instead takes an
 *    injectable `getWorking: () => boolean` — same shape as
 *    `machineClient.ts`'s `buildMetadata`/`buildRuntimeState` — so callers
 *    (and tests) can supply it however they like today, and the eventual
 *    orchestration layer wires a mutable flag toggled by `onThinkingChange`
 *    into `getWorking` without touching this module.
 *  - issue-4-plan.md §6.6: the auth handshake takes a live `TokenProvider`
 *    (not a fixed `token: string`) via an async `auth` callback — mirrors
 *    `machineClient.ts` exactly, closing the "`falcon claude` outlives the
 *    access token's TTL" gap `commands/start.ts` used to document as a known
 *    scope cut: a proactive in-band `renew-token` re-arms ~10 minutes before
 *    the token would go stale, and an auth-shaped `connect_error` forces one
 *    refresh so the NEXT automatic reconnect presents a fresh credential.
 *  - Reconnect handling mirrors `machineClient.ts` exactly: socket.io-client's
 *    own auto-reconnect handles ordinary transport drops; an explicit
 *    `disconnect` handler re-triggers `socket.connect()` only for the one
 *    case socket.io-client does NOT auto-retry (`"io server disconnect"`),
 *    and the keepalive/renew timers are stopped/restarted around the
 *    connected state so a dead connection never appears "alive" server-side.
 */

import { EphemeralSchema } from "@falcon/wire";
import { io as ioClientDefault, type Socket } from "socket.io-client";
import type { TokenProvider } from "../auth/tokenProvider.js";
import type { Logger } from "../logger.js";

export interface SessionClientDeps {
  serverUrl: string;
  /** Mints/caches/refreshes the access token this socket authenticates with —
   * see the module docblock's §6.6 note. */
  tokenProvider: TokenProvider;
  sessionId: string;
  /** Injectable so unit tests never make a real network call. */
  ioFactory: (url: string, opts: Record<string, unknown>) => Socket;
  logger: Logger;
  aliveIntervalMs: number;
  /** How long after each successful (re)connect/renew to proactively re-authenticate
   * the same live socket — mirrors `machineClient.ts`'s own fixed interval, comfortably
   * inside the access token's TTL (15m from Phase 6, 1h before). */
  renewIntervalMs: number;
  /**
   * Returns the current working/idle flag to attach to the next `alive`
   * emit. Placeholder for the real fd3 thinking-state signal, which lives in
   * `claudeLocal.ts`'s `onThinkingChange` callback — callers wire that in
   * once the session-process orchestration layer that starts both modules
   * together exists (plan.md §16, still unbuilt), by passing a `getWorking`
   * that reads a flag toggled from `onThinkingChange` instead of the default
   * `false`.
   */
  getWorking: () => boolean;
  /**
   * Fires when another device asks for a copy of this account's keys, learned via the
   * `"key-request"` ephemeral (auth-ux-overhaul-fix-plan.md Fix 7). Optional: the daemon's
   * own `machineClient.ts` already logs this to a file nobody reads, so a caller that
   * doesn't supply this simply keeps that (invisible) behavior — no regression, just no
   * improvement.
   */
  onKeyRequest?: (payload: { label: string | null }) => void;
}

export function createSessionClientDeps(
  required: Pick<SessionClientDeps, "serverUrl" | "tokenProvider" | "sessionId">,
  overrides: Partial<SessionClientDeps> = {},
): SessionClientDeps {
  return {
    ioFactory: (url, opts) => ioClientDefault(url, opts),
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    aliveIntervalMs: 20_000,
    renewIntervalMs: 10 * 60 * 1000,
    getWorking: () => false,
    ...required,
    ...overrides,
  };
}

export interface SessionClientHandle {
  readonly connected: boolean;
  /**
   * The underlying socket.io-client `Socket` this client opened — exposed so
   * a caller can layer another protocol over the same session-scoped
   * connection (namely `rpc/sessionRpc.ts`'s `registerSessionRpcHandlers`,
   * which needs a live `Socket` to join `rpc-register` rooms on and listen
   * for `rpc-request` on) without opening a second, redundant connection.
   */
  readonly socket: Socket;
  stop: () => void;
}

/**
 * Opens the `/v1/stream` socket (`clientType: "session-scoped"`) and starts
 * the `alive` keepalive loop. Returns immediately with a handle — there is
 * no registration round-trip to await (unlike `startMachineClient`, session
 * creation already happened via `POST /v1/sessions` before this client is
 * started).
 */
export function startSessionClient(deps: SessionClientDeps): SessionClientHandle {
  const socket = deps.ioFactory(deps.serverUrl, {
    path: "/v1/stream",
    transports: ["websocket"],
    // issue-4-plan.md §6.6: an async callback (not a static object) so every
    // (re)connection attempt — including automatic reconnects long after this process
    // started — asks `tokenProvider` for a currently-valid access token instead of
    // replaying whatever was valid when the socket was first opened.
    auth: async (cb: (data: Record<string, unknown>) => void) => {
      const token = (await deps.tokenProvider.getAccessToken()) ?? "";
      cb({ token, clientType: "session-scoped", sessionId: deps.sessionId });
    },
  });

  let aliveTimer: ReturnType<typeof setInterval> | null = null;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let connected = false;

  function stopAlive(): void {
    if (aliveTimer) {
      clearInterval(aliveTimer);
      aliveTimer = null;
    }
  }

  function sendAlive(): void {
    socket.volatile.emit("alive", { sessionId: deps.sessionId, working: deps.getWorking() });
  }

  function startAlive(): void {
    stopAlive();
    sendAlive();
    aliveTimer = setInterval(sendAlive, deps.aliveIntervalMs);
  }

  function stopRenewTimer(): void {
    if (renewTimer) {
      clearTimeout(renewTimer);
      renewTimer = null;
    }
  }

  // Proactive in-band renewal (§4.5/§6.6): re-authenticates the SAME live socket
  // roughly `renewIntervalMs` after connecting, rather than waiting for the server to
  // drop the connection once the access token presented at handshake time expires.
  function armRenewTimer(): void {
    stopRenewTimer();
    renewTimer = setTimeout(async () => {
      if (stopped) return;
      const token = await deps.tokenProvider.getAccessToken();
      if (!token) {
        deps.logger.warn(
          "[session-client] could not obtain an access token to renew — re-authentication required, run `falcon auth login`",
        );
        return;
      }
      socket.emit("renew-token", token, (ok: boolean) => {
        if (ok) armRenewTimer();
        else deps.logger.warn("[session-client] renew-token was rejected by the server");
      });
    }, deps.renewIntervalMs);
  }

  socket.on("connect", () => {
    if (stopped) return;
    connected = true;
    deps.logger.info("[session-client] connected", { sessionId: deps.sessionId });
    startAlive();
    armRenewTimer();
  });

  // The session socket joins `user:${accountId}` like every other connection
  // (server/src/app/events/eventRouter.ts:116-118), so a key request raised on another
  // device already lands here — it was simply never listened for. The daemon's own handler
  // (daemon/machineClient.ts) logs it to a file nobody reads; this is the copy that can
  // reach a human, because a `falcon claude` session has a real terminal attached.
  socket.on("ephemeral", (payload: unknown) => {
    const parsed = EphemeralSchema.safeParse(payload);
    if (!parsed.success || parsed.data.t !== "key-request") return;
    deps.onKeyRequest?.({ label: parsed.data.label });
  });

  socket.on("connect_error", (error: Error) => {
    // The server rejects the handshake itself (bad/expired token, missing
    // sessionId, ...) via `connect_error`, not `disconnect` — socket.io-client
    // keeps retrying automatically either way, but silently, so this must be
    // logged or a persistent auth/config problem would never be visible
    // (no-silent-failures).
    deps.logger.warn("[session-client] connect error", { error: error.message });

    // issue-4-plan.md §6.6: an auth-shaped rejection means the access token the last
    // handshake presented was stale/revoked — force a refresh so the NEXT automatic
    // reconnect attempt presents a fresh one instead of the same dead credential.
    if (/authentication token|Session revoked/i.test(error.message)) {
      void deps.tokenProvider.forceRefresh();
    }
  });

  socket.on("disconnect", (reason: string) => {
    connected = false;
    deps.logger.info("[session-client] disconnected", { reason, sessionId: deps.sessionId });
    stopAlive();
    stopRenewTimer();

    // socket.io-client auto-reconnects on transport drops, but NOT when the
    // server explicitly disconnects the socket (`reason === "io server
    // disconnect"`) — that case requires an explicit `connect()` per the
    // client's own docs. This is a persistent connection (design §8), so it
    // must always keep trying regardless of why it went down, unless we're
    // the one shutting it down (`stopped`).
    if (!stopped) socket.connect();
  });

  return {
    get connected() {
      return connected;
    },
    socket,
    stop: () => {
      stopped = true;
      connected = false;
      stopAlive();
      stopRenewTimer();
      socket.close();
    },
  };
}
