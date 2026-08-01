"use client";

import { useEffect, useState } from "react";
import { apiSocket } from "@/sync";

/** The narrow slice of `apiSocket` this hook needs — real `apiSocket`
 * (`@/sync`) satisfies this structurally; tests can pass an in-memory
 * double instead, mirroring `use-session-ephemerals.ts`'s `EphemeralSource`
 * seam. */
export interface ConnectivitySource {
  isConnected(): boolean;
  /** Synchronous query mirroring `isConnected()` — see `apiSocket.ts`'s
   * `isAuthExpired()` doc comment for why this needs to be queryable at
   * mount, not just reactive via the `authError` event below. */
  isAuthExpired(): boolean;
  on(event: "connect" | "disconnect" | "authError", handler: () => void): () => void;
}

export interface ConnectivityState {
  /** `navigator.onLine` — the browser's own network-reachability guess.
   * `true` in any environment without a `navigator` (the static prerender,
   * or a test with no DOM) so nothing spuriously renders "offline" there. */
  online: boolean;
  /** Whether `apiSocket`'s WS connection is currently up. Distinct from
   * `online`: a genuinely offline browser is caught by the check above
   * before the socket even gets a chance to report disconnected, while a
   * *reachable* network with the Kvy server unreachable (server down,
   * blocked, auth failure) only ever shows up here. */
  wsConnected: boolean;
  /** True once the server has rejected a (re)connection attempt as an auth
   * failure (bug-fix-plan.md issue #10 — `apiSocket`'s `authError` event).
   * Distinct from a plain `!wsConnected`: this is a permanent condition the
   * infinite-retry engine cannot resolve on its own by waiting — the banner
   * should stop reading "Reconnecting…" and tell the user to sign in again
   * instead (see `OfflineBanner`). */
  authExpired: boolean;
}

function readBrowserOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

/**
 * Combines `navigator.onLine` + `apiSocket`'s connect/disconnect events into
 * one signal for `OfflineBanner` (plan-v2.md W4.2 "offline banner
 * (`navigator.onLine` + WS state from `apiSocket`)"). Two independent
 * `useEffect`s (browser online/offline vs. socket connect/disconnect) since
 * they're genuinely different event sources with no shared lifecycle.
 */
export function useConnectivity(source: ConnectivitySource = apiSocket): ConnectivityState {
  const [online, setOnline] = useState(readBrowserOnline);
  const [wsConnected, setWsConnected] = useState(() => source.isConnected());
  const [authExpired, setAuthExpired] = useState(() => source.isAuthExpired());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    setWsConnected(source.isConnected());
    setAuthExpired(source.isAuthExpired());
    const offConnect = source.on("connect", () => {
      setWsConnected(true);
      // A successful (re)connect only happens with a token the server just
      // accepted — clears a previous authError's lingering state.
      setAuthExpired(false);
    });
    const offDisconnect = source.on("disconnect", () => setWsConnected(false));
    const offAuthError = source.on("authError", () => setAuthExpired(true));
    return () => {
      offConnect();
      offDisconnect();
      offAuthError();
    };
  }, [source]);

  return { online, wsConnected, authExpired };
}
