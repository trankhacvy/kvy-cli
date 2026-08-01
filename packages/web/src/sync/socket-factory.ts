/**
 * Real Socket.IO entry point for apiSocket. Kept separate from apiSocket.ts
 * so the client's connection/backoff logic can be unit-tested against an
 * in-memory `SocketLike` double without a live network connection (mirrors
 * `crypto/factory.ts`'s split from `crypto/client.ts`).
 */
import { io } from "socket.io-client";
import { API_URL } from "@/lib/config.js";
import type { ApiSocketAuth, SocketFactory } from "./apiSocket.js";

/**
 * `serverUrl` defaults to `lib/config.ts`'s `API_URL` (the same
 * `NEXT_PUBLIC_API_URL`-derived base every HTTP call in this app already
 * uses — see `lib/api.ts`) but is overridable for tests/other environments.
 * Previously read a second, different env var (`NEXT_PUBLIC_KVY_API_URL`)
 * independently of `lib/config.ts` — two names for the same "where's the
 * server" setting meant a deployment (or a local dev setup) that only set
 * one of them left the WS client silently pointed at the wrong origin while
 * every HTTP call worked fine, exactly the kind of split-brain config this
 * single import now rules out.
 */
export function createSocketFactory(serverUrl: string = API_URL): SocketFactory {
  return (getAuth: () => ApiSocketAuth) =>
    io(serverUrl, {
      path: "/v1/stream", // matches the server's Socket.IO mount (P1-1.1-server-realtime socket.ts)
      transports: ["websocket", "polling"],
      autoConnect: false, // apiSocket calls `.connect()` itself once a token is available
      reconnection: true,
      reconnectionAttempts: Number.POSITIVE_INFINITY, // infinite reconnect — plan.md 1.6 / design §9.1
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5, // jitter so a server restart doesn't thundering-herd every client at once
      timeout: 20_000,
      // Re-invoked by Socket.IO before every (re)connection attempt, so the
      // handshake always carries the *current* token + app-state — not just
      // whatever was true when `io()` was first called (design §9.1; the
      // server reads these in `io.use()` middleware before `connection`
      // fires, see P1-1.1-server-realtime's socket.ts).
      auth: (cb: (data: ApiSocketAuth) => void) => cb(getAuth()),
    });
}
