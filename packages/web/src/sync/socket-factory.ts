/**
 * Real Socket.IO entry point for apiSocket. Kept separate from apiSocket.ts
 * so the client's connection/backoff logic can be unit-tested against an
 * in-memory `SocketLike` double without a live network connection (mirrors
 * `crypto/factory.ts`'s split from `crypto/client.ts`).
 */
import { io } from "socket.io-client";
import type { ApiSocketAuth, SocketFactory } from "./apiSocket.js";

// Same-origin by default (falcon-system-design.md §6.5: the web app can be
// served by the API process itself in the self-host shape). Override for
// local dev, where `next dev` and the API server run on different ports, or
// when the web app is statically hosted separately from the API (§5.3/§9.1:
// "served as a PWA from a separate static origin").
const DEFAULT_SERVER_URL =
  typeof process !== "undefined" &&
  process.env.NEXT_PUBLIC_FALCON_API_URL &&
  process.env.NEXT_PUBLIC_FALCON_API_URL.length > 0
    ? process.env.NEXT_PUBLIC_FALCON_API_URL
    : "http://localhost:3005";

/**
 * `serverUrl` defaults to `NEXT_PUBLIC_FALCON_API_URL` (falls back to the
 * local dev server) but is overridable for tests/other environments.
 */
export function createSocketFactory(serverUrl: string = DEFAULT_SERVER_URL): SocketFactory {
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
