import { Counter, Histogram, register } from "prom-client";
import type { DefaultEventsMap, RemoteSocket, Server, Socket } from "socket.io";
import { RpcRateLimiter } from "./rpcRateLimiter.js";

// Ported wholesale from Happy's `happy-server/sources/app/api/socket/rpcHandler.ts`
// (plan.md §4.2: "copy it wholesale" — this is the postmortem-hardened dead-peer-detection
// code). Only renames: `userId` -> `accountId`, and the registered room key is Falcon's
// wire-level scope-prefixed `target` (e.g. `m:<machineId>:spawn` / `s:<sessionId>:spawn` —
// `@falcon/wire`'s `RpcCallSchema`) rather than Happy's ad-hoc `<id>:<method>` string; the
// bare `method` field travels alongside purely for metrics labels and the forwarded
// `rpc-request` payload, so no `baseMethodName` prefix-stripping is needed here.
//
// RPC routing uses Socket.IO rooms. A daemon/session registering a target T joins room
// `rpc:<accountId>:T`. Callers look the target up via `io.in(room).fetchSockets()` — this
// resolves cross-replica once the Redis cluster adapter is enabled (falcon-system-design.md
// §6.4 "reserved behind an env flag"); at MVP (single process) it resolves against the local
// in-memory adapter.
//
// No Redis keys, no TTLs, no keep-alive refresh path. On disconnect Socket.IO removes the
// socket from all rooms automatically.

const RPC_ROOM_PREFIX = "rpc:";
const RPC_CALL_TIMEOUT_MS = 30_000;
// falcon-system-design.md §13 / plan.md §16 "4.4 Hardening": "dead-peer fast-fail
// (<2s)" — the SLO Happy's own postmortem-hardened design measured at ~1.6s against a
// real 2-replica cluster (happy-research.md §7/§11.3: "presence-poll race for fast
// dead-peer detection ... pod-kill fast-fail: 1.6s vs 30s"). Two consecutive misses are
// still required (below) to avoid false positives from a single transient adapter
// timeout, so this must stay comfortably under 1000ms for the worst case (two full
// poll intervals) to land under the 2s SLO.
const RPC_PRESENCE_POLL_MS = 700;
// Timeouts for cross-replica fetchSockets during the reconnect grace window. Exponential
// backoff: 2s -> 4s -> 8s. Reduces stream pressure under load (fewer timed-out requests)
// while giving later attempts more time to succeed when the adapter is slow.
const RPC_LOOKUP_FETCH_TIMEOUTS_MS = [2_000, 4_000, 8_000];
// Timeout for in-flight presence-poll fetchSockets. Must be << RPC_CALL_TIMEOUT_MS (and
// << RPC_PRESENCE_POLL_MS) so a dead replica doesn't stall each poll for the full adapter
// heartbeat timeout — keeps the <2s dead-peer SLO above intact even if one poll's fetch
// itself times out.
const RPC_PRESENCE_FETCH_TIMEOUT_MS = 400;
// How long an rpc-call waits for the target socket to appear in the room when the room is
// empty at call time (e.g. a brief daemon reconnect window). With exponential backoff
// (2s, 4s, 8s) + 200ms sleep between polls, this gives ~3 iterations of increasing timeout
// budget — fewer requests under load while still catching a target mid-reconnect.
const RPC_RECONNECT_GRACE_MS = 15_000;
const RPC_RECONNECT_POLL_MS = 200;

// Per-account rpc-call ceiling (falcon-system-design.md §12, plan.md §16 "4.4
// Hardening": rate limiting on "RPC endpoints" — one of the reported Happy vuln
// classes). Matches server.ts's global HTTP default (300/min) so RPC traffic gets the
// same baseline throughput budget as everything else.
export const RPC_CALL_RATE_LIMIT_MAX = 300;
const RPC_CALL_RATE_LIMIT_WINDOW_MS = 60_000;

// Module-level singleton (not per-connection) so the window is tracked per accountId
// across that account's whole set of sockets/reconnects, not reset every time a new
// socket connects.
const defaultRpcRateLimiter = new RpcRateLimiter({
  max: RPC_CALL_RATE_LIMIT_MAX,
  windowMs: RPC_CALL_RATE_LIMIT_WINDOW_MS,
});

const rpcCallCounter = new Counter({
  name: "rpc_calls_total",
  help: "Total RPC calls by method and outcome",
  labelNames: ["method", "result"] as const,
  registers: [register],
});

const rpcCallDuration = new Histogram({
  name: "rpc_call_duration_seconds",
  help: "RPC call duration from receipt to response",
  labelNames: ["method", "result"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30],
  registers: [register],
});

const rpcLookupRetries = new Histogram({
  name: "rpc_lookup_retries",
  help: "Number of grace-window polls before finding the RPC target (0 = instant)",
  labelNames: ["method"] as const,
  buckets: [0, 1, 2, 3, 4, 5, 6, 7],
  registers: [register],
});

const rpcFetchSocketsTimeouts = new Counter({
  name: "rpc_fetchsockets_timeouts_total",
  help: "Cross-replica fetchSockets timeouts by context",
  labelNames: ["context"] as const,
  registers: [register],
});

function rpcRoom(accountId: string, target: string): string {
  return `${RPC_ROOM_PREFIX}${accountId}:${target}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RoomSockets = RemoteSocket<DefaultEventsMap, unknown>[];

/**
 * fetchSockets(room) wrapped with a caller-specified timeout. Returns `[]` and logs on
 * failure (cluster-adapter request timeout, peer replica unresponsive). Use
 * RPC_LOOKUP_FETCH_TIMEOUTS_MS for target lookups (initial + grace window) and
 * RPC_PRESENCE_FETCH_TIMEOUT_MS for in-flight presence polling.
 */
async function fetchRoomSockets(
  io: Server,
  room: string,
  timeoutMs: number,
  context: "lookup" | "presence" = "lookup",
): Promise<RoomSockets> {
  try {
    return await io.in(room).timeout(timeoutMs).fetchSockets();
  } catch (error) {
    rpcFetchSocketsTimeouts.inc({ context });
    console.error(
      { module: "websocket" },
      `fetchSockets failed for ${room} (timeout=${timeoutMs}ms): ${error}`,
    );
    return [];
  }
}

/**
 * Poll fetchRoomSockets until it returns at least one socket OR `maxMs` elapses. Uses
 * exponential backoff on fetch timeouts (2s, 4s, 8s) to reduce stream pressure when the
 * adapter is slow — fewer requests in flight means less amplification of the
 * timeout -> retry -> timeout spiral.
 */
async function waitForRoomMember(
  io: Server,
  room: string,
  maxMs: number,
  metricMethod: string,
): Promise<RoomSockets> {
  const deadline = Date.now() + maxMs;
  let polls = 0;
  while (true) {
    const timeoutMs =
      RPC_LOOKUP_FETCH_TIMEOUTS_MS[Math.min(polls, RPC_LOOKUP_FETCH_TIMEOUTS_MS.length - 1)] ??
      RPC_LOOKUP_FETCH_TIMEOUTS_MS[0]!;
    const sockets = await fetchRoomSockets(io, room, timeoutMs);
    if (sockets.length > 0) {
      rpcLookupRetries.observe({ method: metricMethod }, polls);
      return sockets;
    }
    if (Date.now() >= deadline) {
      rpcLookupRetries.observe({ method: metricMethod }, polls);
      return sockets;
    }
    polls++;
    await sleep(RPC_RECONNECT_POLL_MS);
  }
}

interface RpcCallData {
  target?: unknown;
  method?: unknown;
  params?: unknown;
}

interface RpcRegisterData {
  target?: unknown;
}

export function rpcHandler(
  accountId: string,
  socket: Socket,
  io: Server,
  rateLimiter: RpcRateLimiter = defaultRpcRateLimiter,
): void {
  socket.on("rpc-register", (data: RpcRegisterData) => {
    try {
      const { target } = data ?? {};
      if (!target || typeof target !== "string") {
        socket.emit("rpc-error", { type: "register", error: "Invalid target" });
        return;
      }
      socket.join(rpcRoom(accountId, target));
      socket.emit("rpc-registered", { target });
    } catch (error) {
      console.error({ module: "websocket", level: "error" }, `Error in rpc-register: ${error}`);
      socket.emit("rpc-error", { type: "register", error: "Internal error" });
    }
  });

  socket.on("rpc-unregister", (data: RpcRegisterData) => {
    try {
      const { target } = data ?? {};
      if (!target || typeof target !== "string") {
        socket.emit("rpc-error", { type: "unregister", error: "Invalid target" });
        return;
      }
      socket.leave(rpcRoom(accountId, target));
      socket.emit("rpc-unregistered", { target });
    } catch (error) {
      console.error({ module: "websocket", level: "error" }, `Error in rpc-unregister: ${error}`);
      socket.emit("rpc-error", { type: "unregister", error: "Internal error" });
    }
  });

  socket.on("rpc-call", async (data: RpcCallData, callback?: (response: unknown) => void) => {
    const startTime = Date.now();
    const { target, method, params } = data ?? {};

    const finish = (result: string) => {
      const durationSec = (Date.now() - startTime) / 1000;
      const m = typeof method === "string" && method.length > 0 ? method : "unknown";
      rpcCallCounter.inc({ method: m, result });
      rpcCallDuration.observe({ method: m, result }, durationSec);
    };

    try {
      if (!target || typeof target !== "string" || !method || typeof method !== "string") {
        finish("invalid_params");
        callback?.({ ok: false, error: "Invalid parameters: target and method are required" });
        return;
      }

      if (!rateLimiter.tryConsume(accountId)) {
        finish("rate_limited");
        callback?.({ ok: false, error: "Rate limit exceeded" });
        return;
      }

      // 1. Find the target socket(s) via the adapter (cross-replica once the Redis
      // adapter is enabled). If the room is empty OR fetchSockets fails, fall through
      // to the wait-for-reconnect grace window.
      const room = rpcRoom(accountId, target);
      let targets = await fetchRoomSockets(io, room, RPC_LOOKUP_FETCH_TIMEOUTS_MS[0]!);
      if (targets.length === 0) {
        targets = await waitForRoomMember(io, room, RPC_RECONNECT_GRACE_MS, method);
      }

      if (targets.length === 0) {
        finish("not_available");
        callback?.({ ok: false, error: "RPC target not available" });
        return;
      }
      if (targets.length > 1) {
        console.warn(
          { module: "websocket", level: "warn" },
          `Multiple sockets in ${room} (${targets.length}); using first`,
        );
      }

      const rpcTarget = targets[0]!;
      if (rpcTarget.id === socket.id) {
        finish("self_call");
        callback?.({ ok: false, error: "Cannot call RPC on the same socket" });
        return;
      }

      // 2. Single-target emit with timeout — works cross-replica via the adapter.
      //
      // Race against a presence poll that aborts fast if the target leaves the room.
      // WHY: emitWithAck has no idea the target socket is dead; when the target's
      // process dies mid-call, the outgoing request is queued waiting for an ack that
      // will never come, and it only times out at RPC_CALL_TIMEOUT_MS (30s). Polling
      // fetchSockets is the only way to detect "the target socket is gone" and abort
      // fast (~2-4s). Requires 2 consecutive empty polls before declaring disconnect,
      // to avoid false positives from transient adapter timeouts.
      const ackPromise = rpcTarget
        .timeout(RPC_CALL_TIMEOUT_MS)
        .emitWithAck("rpc-request", { method, params });

      let presenceAlive = true;
      const presencePoll = (async () => {
        let consecutiveMisses = 0;
        while (presenceAlive) {
          await sleep(RPC_PRESENCE_POLL_MS);
          if (!presenceAlive) return;
          const stillThere = await fetchRoomSockets(
            io,
            room,
            RPC_PRESENCE_FETCH_TIMEOUT_MS,
            "presence",
          );
          if (!stillThere.some((s) => s.id === rpcTarget.id)) {
            consecutiveMisses++;
            if (consecutiveMisses >= 2) {
              throw new Error("RPC target disconnected");
            }
          } else {
            consecutiveMisses = 0;
          }
        }
      })();

      try {
        const response = await Promise.race([ackPromise, presencePoll]);
        finish("success");
        callback?.({ ok: true, result: response });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "RPC call failed";
        finish(errorMsg === "RPC target disconnected" ? "target_disconnected" : "timeout");
        callback?.({ ok: false, error: errorMsg });
      } finally {
        presenceAlive = false;
      }
    } catch (error) {
      finish("internal_error");
      console.error({ module: "websocket", level: "error" }, `Error in rpc-call: ${error}`);
      callback?.({ ok: false, error: "Internal error" });
    }
  });

  // No disconnect handler — Socket.IO removes the socket from all rooms automatically,
  // and the cluster adapter (once enabled) syncs the removal to other replicas.
}
