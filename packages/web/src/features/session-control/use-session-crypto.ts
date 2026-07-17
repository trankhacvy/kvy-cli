"use client";

import { decodeBase64 } from "@falcon/crypto/web";
import { useEffect, useState } from "react";
import type { CryptoBridgeClient } from "@/crypto";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";

/**
 * Unwraps `sessionId`'s data-encryption key into a fresh crypto-bridge
 * worker (falcon-system-design.md §5.3, plan.md's "per-session DEK-unwrap
 * crypto worker" bullet) — `null` until the session's row has synced *and*
 * `setSessionKey` has resolved `true`. `useLiveRenderItems` (decrypting
 * messages) and `useLiveSessionControl` (sealing/opening RPC params/
 * results) each call this with the same `sessionId` so they always agree on
 * which session's key is loaded, without sharing any other state.
 */
export function useSessionCrypto(sessionId: string): CryptoBridgeClient | null {
  const bridge = useCryptoBridge();
  const snapshot = useSyncSnapshotQuery();
  const [ready, setReady] = useState(false);

  const dek = snapshot.data?.sessions.find((s) => s.id === sessionId)?.dek ?? null;

  useEffect(() => {
    setReady(false);
    if (!bridge || dek === null) return;
    let cancelled = false;
    bridge
      .setSessionKey(decodeBase64(dek))
      .then((ok) => {
        if (cancelled) return;
        if (!ok) {
          console.error(`useSessionCrypto: session ${sessionId}'s DEK failed to unwrap`);
        }
        setReady(ok);
      })
      .catch((err) => {
        // A rejected (not just `false`-resolved) `setSessionKey` call means the
        // worker itself errored/crashed mid-call (`client.ts`'s `rejectAllPending`)
        // — still visible (design principle: no silent failures), not just an
        // unhandled rejection swallowed by the effect.
        if (cancelled) return;
        console.error(`useSessionCrypto: session ${sessionId}'s setSessionKey call failed`, err);
        setReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, dek, sessionId]);

  return ready ? bridge : null;
}
