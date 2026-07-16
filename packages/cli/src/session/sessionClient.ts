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
 *    (thinking-state parsed off Claude's stdio fd3 stream) lives in the
 *    still-unmerged `claudeLocal.ts`. This client instead takes an
 *    injectable `getWorking: () => boolean` — same shape as
 *    `machineClient.ts`'s `buildMetadata`/`buildRuntimeState` — so callers
 *    (and tests) can supply it however they like today and swap in the real
 *    fd3-backed source later without touching this module.
 *  - Reconnect handling mirrors `machineClient.ts` exactly: socket.io-client's
 *    own auto-reconnect handles ordinary transport drops; an explicit
 *    `disconnect` handler re-triggers `socket.connect()` only for the one
 *    case socket.io-client does NOT auto-retry (`"io server disconnect"`),
 *    and the keepalive timer is stopped/restarted around the connected
 *    state so a dead connection never appears "alive" server-side.
 */

import { io as ioClientDefault, type Socket } from "socket.io-client";
import type { Logger } from "../logger.js";

export interface SessionClientDeps {
  serverUrl: string;
  token: string;
  sessionId: string;
  /** Injectable so unit tests never make a real network call. */
  ioFactory: (url: string, opts: Record<string, unknown>) => Socket;
  logger: Logger;
  aliveIntervalMs: number;
  /**
   * Returns the current working/idle flag to attach to the next `alive`
   * emit. Placeholder for the real fd3 thinking-state signal, which lives
   * in the still-unmerged `claudeLocal.ts` — callers wire that in later by
   * passing a `getWorking` that reads it instead of the default `false`.
   */
  getWorking: () => boolean;
}

export function createSessionClientDeps(
  required: Pick<SessionClientDeps, "serverUrl" | "token" | "sessionId">,
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
    getWorking: () => false,
    ...required,
    ...overrides,
  };
}

export interface SessionClientHandle {
  readonly connected: boolean;
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
    auth: { token: deps.token, clientType: "session-scoped", sessionId: deps.sessionId },
  });

  let aliveTimer: ReturnType<typeof setInterval> | null = null;
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

  socket.on("connect", () => {
    if (stopped) return;
    connected = true;
    deps.logger.info("[session-client] connected", { sessionId: deps.sessionId });
    startAlive();
  });

  socket.on("connect_error", (error: Error) => {
    // The server rejects the handshake itself (bad/expired token, missing
    // sessionId, ...) via `connect_error`, not `disconnect` — socket.io-client
    // keeps retrying automatically either way, but silently, so this must be
    // logged or a persistent auth/config problem would never be visible
    // (no-silent-failures).
    deps.logger.warn("[session-client] connect error", { error: error.message });
  });

  socket.on("disconnect", (reason: string) => {
    connected = false;
    deps.logger.info("[session-client] disconnected", { reason, sessionId: deps.sessionId });
    stopAlive();

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
    stop: () => {
      stopped = true;
      connected = false;
      stopAlive();
      socket.close();
    },
  };
}
