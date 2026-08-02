import { io } from "socket.io-client";
import { API_URL } from "@/lib/config.js";
import type { ApiSocketAuth, SocketFactory } from "./apiSocket.js";

/**
 * `serverUrl` is overridable but defaults to `API_URL` from `lib/config.ts` -
 * the same base every HTTP call uses. Previously read a separate env var
 * (`NEXT_PUBLIC_KVY_API_URL`); having two names for the same setting caused
 * silent split-brain configs where every HTTP call worked but the WS client
 * pointed at the wrong origin.
 */
export function createSocketFactory(serverUrl: string = API_URL): SocketFactory {
  return (getAuth: () => ApiSocketAuth) =>
    io(serverUrl, {
      path: "/v1/stream",
      transports: ["websocket", "polling"],
      autoConnect: false, // apiSocket calls `.connect()` itself once a token is available
      reconnection: true,
      reconnectionAttempts: Number.POSITIVE_INFINITY,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5, // jitter so a server restart doesn't thundering-herd every client at once
      timeout: 20_000,
      // Re-invoked before every (re)connection attempt so the handshake always
      // carries the current token, not just whatever was true when `io()` was first called.
      auth: (cb: (data: ApiSocketAuth) => void) => cb(getAuth()),
    });
}
