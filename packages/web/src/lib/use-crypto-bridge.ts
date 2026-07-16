"use client";

import { useEffect, useRef, useState } from "react";
import { type CryptoBridgeClient, createCryptoBridge } from "@/crypto";

/**
 * Spins up a crypto-bridge worker for the lifetime of the calling component
 * and terminates it on unmount. Each auth page owns its own worker instance
 * rather than sharing a cross-page singleton — simpler lifecycle, and every
 * operation these pages need (`getIdentity`, `init`, `signInChallenge`, …)
 * is cheap to re-derive from the IndexedDB-persisted master secret on a
 * fresh worker (`worker-handler.ts`'s lazy `ensureStartupLoaded`).
 */
export function useCryptoBridge(): CryptoBridgeClient | null {
  const [bridge, setBridge] = useState<CryptoBridgeClient | null>(null);
  const bridgeRef = useRef<CryptoBridgeClient | null>(null);

  useEffect(() => {
    const created = createCryptoBridge();
    bridgeRef.current = created;
    setBridge(created);
    return () => {
      created.terminate();
      if (bridgeRef.current === created) {
        bridgeRef.current = null;
      }
    };
  }, []);

  return bridge;
}
