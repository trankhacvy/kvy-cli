import type { Ephemeral, Update } from "@kvy/wire";
import type { Server, Socket } from "socket.io";

// `userId` -> `accountId` (Kvy's identity anchor), and payload shapes come from
// Happy has no equivalent.

// === CONNECTION TYPES ===

export interface SessionScopedConnection {
  connectionType: "session-scoped";
  socket: Socket;
  accountId: string;
  sessionId: string;
}

export interface UserScopedConnection {
  connectionType: "user-scoped";
  socket: Socket;
  accountId: string;
}

export interface MachineScopedConnection {
  connectionType: "machine-scoped";
  socket: Socket;
  accountId: string;
  machineId: string;
}

export type ClientConnection =
  | SessionScopedConnection
  | UserScopedConnection
  | MachineScopedConnection;

// === RECIPIENT FILTER TYPES ===

export type RecipientFilter =
  | { type: "all-interested-in-session"; sessionId: string }
  | { type: "user-scoped-only" }
  | { type: "machine-scoped-only"; machineId: string }
  | { type: "all-user-authenticated-connections" };

// === EVENT EMISSION PARAMS ===

export interface EmitUpdateParams {
  accountId: string;
  payload: Update;
  recipientFilter?: RecipientFilter;
  skipSenderConnection?: ClientConnection;
}

export interface EmitEphemeralParams {
  accountId: string;
  payload: Ephemeral;
  recipientFilter?: RecipientFilter;
  skipSenderConnection?: ClientConnection;
}

/**
 * The fan-out seam the HTTP write path (task 1.2, `app/routes/*`) depends
 * on: every write route calls `emitUpdate`/`emitEphemeral` post-commit
 * Socket.IO rooms directly. Narrowed to just the two emit methods (not the
 * full `EventRouter` surface below, which also owns connection/room
 * bookkeeping that only `socket.ts` needs) so route tests can inject a
 * lightweight recording fake instead of a real Socket.IO server.
 */
export interface EventRouterPort {
  emitUpdate(params: EmitUpdateParams): void;
  emitEphemeral(params: EmitEphemeralParams): void;
}

//
// Persistent `update`s are never dropped (a slow client falls back to the HTTP
// refetch path). Ephemeral `activity`/`attention` events are droppable by design,
// so once a socket's outbound write buffer backs up past a threshold, we stop
// piling on: keep only the latest payload per (type, sessionId) key and flush it
// once the socket drains, discarding everything superseded in between.
const BACKPRESSURE_WRITE_BUFFER_THRESHOLD = 16;

type CoalesceKey = string;

function coalesceKeyFor(payload: Ephemeral): CoalesceKey | undefined {
  if (payload.t === "activity" || payload.t === "attention") {
    return `${payload.t}:${payload.sessionId}`;
  }
  return undefined;
}

// engine.io's Socket exposes `writeBuffer` (packets queued but not yet flushed to the
// transport) — the standard signal for "this connection can't keep up". Untyped in
// socket.io's public API surface, so accessed defensively.
function writeBufferLength(socket: Socket): number {
  const conn = socket.conn as unknown as { writeBuffer?: unknown[] } | undefined;
  return conn?.writeBuffer?.length ?? 0;
}

// === EVENT ROUTER CLASS ===

class EventRouter {
  private io!: Server;
  private pendingBySocket = new Map<string, Map<CoalesceKey, Ephemeral>>();

  // === INITIALIZATION ===

  init(io: Server): void {
    this.io = io;
  }

  // === CONNECTION MANAGEMENT (via Socket.IO rooms) ===

  addConnection(accountId: string, connection: ClientConnection): void {
    const socket = connection.socket;
    socket.join(`user:${accountId}`);

    switch (connection.connectionType) {
      case "user-scoped":
        socket.join(`user:${accountId}:user-scoped`);
        break;
      case "session-scoped":
        socket.join(`user:${accountId}:session:${connection.sessionId}`);
        break;
      case "machine-scoped":
        socket.join(`user:${accountId}:machine:${connection.machineId}`);
        break;
    }
  }

  removeConnection(_accountId: string, connection: ClientConnection): void {
    // Socket.IO removes the socket from all rooms on disconnect automatically;
    // also drop any coalesced-but-unflushed ephemeral state for this socket.
    this.pendingBySocket.delete(connection.socket.id);
  }

  // === EVENT EMISSION METHODS ===

  emitUpdate(params: EmitUpdateParams): void {
    const rooms = this.getRoomsForFilter(
      params.accountId,
      params.recipientFilter ?? { type: "all-user-authenticated-connections" },
    );
    if (params.skipSenderConnection) {
      params.skipSenderConnection.socket.broadcast.to(rooms).emit("update", params.payload);
    } else {
      this.io.to(rooms).emit("update", params.payload);
    }
  }

  emitEphemeral(params: EmitEphemeralParams): void {
    const rooms = this.getRoomsForFilter(
      params.accountId,
      params.recipientFilter ?? { type: "all-user-authenticated-connections" },
    );
    const skipSocketId = params.skipSenderConnection?.socket.id;

    for (const socket of this.socketsInRooms(rooms)) {
      if (socket.id === skipSocketId) continue;
      this.emitEphemeralToSocket(socket, params.payload);
    }
  }


  /**
   * Every live socket for this account — the accessor `app/socket.ts`'s revoke routes
   * use to find and disconnect a specific `sessionId`'s live connection(s) immediately,
   * rather than waiting out the access token's own TTL. Thin wrapper over the same
   * `user:${accountId}` room every connection already joins in `addConnection` above.
   */
  connectionsForAccount(accountId: string): Socket[] {
    const room = this.io.sockets.adapter.rooms.get(`user:${accountId}`);
    if (!room) return [];
    const sockets: Socket[] = [];
    for (const id of room) {
      const socket = this.io.sockets.sockets.get(id);
      if (socket) sockets.push(socket);
    }
    return sockets;
  }

  // === PRESENCE QUERIES ===

  /**
   * Whether `machineId` currently has a live machine-scoped socket for this
   * account — same room `addConnection` above already joins it to, just read
   * back synchronously (single-process adapter, same precedent as
   * `socketsInRooms` below). Used at `socket.ts`'s connection time to give a
   * freshly-connecting web client an immediate, accurate snapshot of every
   * already-online machine: without this, `useMachinePresence`'s map starts
   * empty and only fills in from a live connect/disconnect/heartbeat AFTER
   * this moment, so a machine that was already online before this tab
   * connected shows via the `lastSeenAt` heuristic (up to ~3 minutes stale)
   * instead of ground truth.
   */
  isMachineOnline(accountId: string, machineId: string): boolean {
    const room = this.io.sockets.adapter.rooms.get(`user:${accountId}:machine:${machineId}`);
    return Boolean(room && room.size > 0);
  }

  /**
   * Returns true if the account has any non-machine socket that hasn't reported
   * `app-state: background`. Clients that never sent `app-state` are treated as
   * active (connected = present).
   */
  async hasActiveNonMachineSocket(accountId: string): Promise<boolean> {
    const sockets = await this.io.in(`user:${accountId}`).fetchSockets();
    return sockets.some((s) => {
      if (s.data.clientType === "machine-scoped") return false;
      const appState = s.data.appState as string | undefined;
      return appState !== "background";
    });
  }

  /**
   * reports `app-state: active` **and** has the session's room joined
   * see `happy-server/sources/app/push/pushDispatch.ts`): scoped to the
   * rooms a given session's traffic actually reaches
   * (`all-interested-in-session`'s room set — session-scoped room ∪
   * user-scoped room) rather than every room the account has any socket in,
   * so a push for session A isn't suppressed by a client that only has
   * session B open.
   *
   * Only `user-scoped` connections count as "a visible client" here —
   * session-scoped sockets are CLI/daemon processes, not humans, and
   * machine-scoped is excluded implicitly (it never joins these rooms). The
   * web app today only ever joins its account-wide `user-scoped` room (it
   * has no per-session "I'm looking at this one" signal yet — no session
   * detail screen exists), so in practice this currently behaves like "the
   * account has an active tab open somewhere" until that screen lands and
   * starts joining the per-session room too — at which point this method
   * needs no further change to start honoring it.
   */
  async hasActiveVisibleClient(accountId: string, sessionId: string): Promise<boolean> {
    const rooms = this.getRoomsForFilter(accountId, {
      type: "all-interested-in-session",
      sessionId,
    });
    const sockets = await this.io.in(rooms).fetchSockets();
    return sockets.some((s) => {
      if (s.data.clientType !== "user-scoped") return false;
      const appState = s.data.appState as string | undefined;
      return appState !== "background";
    });
  }

  // === PRIVATE ROUTING LOGIC ===

  private getRoomsForFilter(accountId: string, filter: RecipientFilter): string[] {
    switch (filter.type) {
      case "all-user-authenticated-connections":
        return [`user:${accountId}`];
      case "user-scoped-only":
        return [`user:${accountId}:user-scoped`];
      case "all-interested-in-session":
        return [`user:${accountId}:session:${filter.sessionId}`, `user:${accountId}:user-scoped`];
      case "machine-scoped-only":
        return [`user:${accountId}:machine:${filter.machineId}`, `user:${accountId}:user-scoped`];
    }
  }

  // Local socket lookup for the ephemeral backpressure path (single-process at MVP —
  // flag"; cross-replica delivery for these events is deferred alongside that flag).
  private socketsInRooms(rooms: string[]): Socket[] {
    const ids = new Set<string>();
    for (const room of rooms) {
      const roomMembers = this.io.sockets.adapter.rooms.get(room);
      if (roomMembers) {
        for (const id of roomMembers) ids.add(id);
      }
    }
    const sockets: Socket[] = [];
    for (const id of ids) {
      const socket = this.io.sockets.sockets.get(id);
      if (socket) sockets.push(socket);
    }
    return sockets;
  }

  private emitEphemeralToSocket(socket: Socket, payload: Ephemeral): void {
    const key = coalesceKeyFor(payload);
    if (!key || writeBufferLength(socket) <= BACKPRESSURE_WRITE_BUFFER_THRESHOLD) {
      socket.emit("ephemeral", payload);
      return;
    }

    let pending = this.pendingBySocket.get(socket.id);
    if (!pending) {
      pending = new Map();
      this.pendingBySocket.set(socket.id, pending);
      this.scheduleFlush(socket, pending);
    }
    // Latest-wins: overwrite whatever was pending for this key.
    pending.set(key, payload);
  }

  private scheduleFlush(socket: Socket, pending: Map<CoalesceKey, Ephemeral>): void {
    const conn = socket.conn;

    const flush = () => {
      for (const payload of pending.values()) socket.emit("ephemeral", payload);
      pending.clear();
      this.pendingBySocket.delete(socket.id);
    };

    conn.once("drain", flush);
    socket.once("disconnect", () => {
      conn.off("drain", flush);
      this.pendingBySocket.delete(socket.id);
    });
  }
}

export const eventRouter = new EventRouter();

// account's live socket(s) for exactly `sessionId` (a revoke only ever kills ONE device
// session, never every connection the account happens to have open) and disconnects
// them right now, rather than waiting for the access token's own TTL to lapse.
export function disconnectSession(router: EventRouter, accountId: string, sessionId: string): void {
  for (const socket of router.connectionsForAccount(accountId)) {
    if (socket.data.authSessionId === sessionId) socket.disconnect(true);
  }
}

// === EVENT BUILDER FUNCTIONS ===

/**
 * AH8 "machine-status-reauth": `needsReauth` is only ever set `true` on the
 * disconnect path, when `socket.ts` has inferred (`machineReauth.ts`'s
 * `computeMachineNeedsReauth`) that this machine's `cli-daemon` device
 * session is revoked — omitted (not just `false`) otherwise, so the emitted
 * payload is byte-identical to the pre-AH8 shape for the overwhelmingly
 * common "just a normal connect/disconnect" case (existing socket.test.ts
 * assertions rely on this exact shape).
 */
/**
 * account so a holder device can offer to approve a key request without polling. Carries
 * no secret — only the requester's ephemeral PUBLIC key and an untrusted display label.
 */
export function buildKeyRequestEphemeral(ephPub: string, label: string | null): Ephemeral {
  return { t: "key-request", ephPub, label };
}

export function buildMachinePresenceEphemeral(
  machineId: string,
  online: boolean,
  needsReauth?: boolean,
): Ephemeral {
  return needsReauth
    ? { t: "machine-presence", machineId, online, needsReauth: true }
    : { t: "machine-presence", machineId, online };
}

/**
 * The `activity` ephemeral a session-scoped socket's `alive` keepalive
 * (`packages/cli/src/session/sessionClient.ts`) turns into server-side:
 * relayed to whoever's watching the session (its own session-scoped room
 * `{ e: 'alive'; sessionId; working }` becomes this `Update`-sibling
 * `Ephemeral` fan-out). This is a pure live relay with no durable cache
 * by a real `machines.lastSeenAt` write-behind cache, see `socket.ts`'s
 * `machine-alive` handler), a session's "is it actively working" state is
 * already sourced from persisted turn-start/turn-end envelopes
 * (`deriveSessionStatus`'s `isTurnOpen`), so there's no separate durable
 * cache worth building for this one.
 */
export function buildSessionActivityEphemeral(sessionId: string, working: boolean): Ephemeral {
  return { t: "activity", sessionId, working };
}
