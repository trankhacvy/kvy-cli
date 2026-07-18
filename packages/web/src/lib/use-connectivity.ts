"use client";

import { useEffect, useState } from "react";
import { apiSocket } from "@/sync";

/** The narrow slice of `apiSocket` this hook needs — real `apiSocket`
 * (`@/sync`) satisfies this structurally; tests can pass an in-memory
 * double instead, mirroring `use-session-ephemerals.ts`'s `EphemeralSource`
 * seam. */
export interface ConnectivitySource {
  isConnected(): boolean;
  on(event: "connect" | "disconnect", handler: () => void): () => void;
}

export interface ConnectivityState {
  /** `navigator.onLine` — the browser's own network-reachability guess.
   * `true` in any environment without a `navigator` (the static prerender,
   * or a test with no DOM) so nothing spuriously renders "offline" there. */
  online: boolean;
  /** Whether `apiSocket`'s WS connection is currently up. Distinct from
   * `online`: a genuinely offline browser is caught by the check above
   * before the socket even gets a chance to report disconnected, while a
   * *reachable* network with the Falcon server unreachable (server down,
   * blocked, auth failure) only ever shows up here. */
  wsConnected: boolean;
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
    const offConnect = source.on("connect", () => setWsConnected(true));
    const offDisconnect = source.on("disconnect", () => setWsConnected(false));
    return () => {
      offConnect();
      offDisconnect();
    };
  }, [source]);

  return { online, wsConnected };
}
