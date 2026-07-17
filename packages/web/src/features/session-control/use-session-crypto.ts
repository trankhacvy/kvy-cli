"use client";

import { decodeBase64 } from "@falcon/crypto/web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { CryptoBridgeClient } from "@/crypto";
import { getSync } from "@/lib/api";
import { getToken } from "@/lib/session";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";
import { apiSocket, createSyncEngine, syncQueryKey } from "@/sync";

/**
 * Keeps the `['sync']` account snapshot populated + live (design §4.3/§9.1)
 * and wires the sync engine to `apiSocket` for the lifetime of the calling
 * component — the one call site (so far) that actually connects the pair
 * `sync/index.ts`'s own docstring describes:
 *
 *   const engine = createSyncEngine(queryClient, apiSocket);
 *
 * Home-screen live-wiring (`features/session-list`) is separate,
 * still-planned follow-up work (see that feature's own `mock-source.ts`);
 * this hook exists purely to back this screen's `useSessionCrypto`. Safe to
 * mount more than once at a time (e.g. once here, once from a sibling
 * `useSessionCrypto` call for the same screen's `SessionControlProvider`) —
 * `apiSocket.connect` is an idempotent no-op for an already-connected token,
 * and a second `createSyncEngine` instance just redundantly observes the
 * same `QueryClient` cache, per that module's own gap-invalidation design.
 */
function useSyncSnapshotQuery() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const token = getToken();
    if (token) apiSocket.connect(token);
    const engine = createSyncEngine(queryClient, apiSocket);
    return () => engine.dispose();
  }, [queryClient]);

  return useQuery({
    queryKey: syncQueryKey,
    queryFn: () => {
      const token = getToken();
      if (!token) throw new Error("Not signed in");
      return getSync(token);
    },
    // Kept current by the sync engine's WS `update` stream, not polling —
    // see engine.ts's own header/message fast-path design.
    staleTime: Number.POSITIVE_INFINITY,
    enabled: getToken() !== null,
  });
}

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
    bridge.setSessionKey(decodeBase64(dek)).then((ok) => {
      if (cancelled) return;
      if (!ok) {
        console.error(`useSessionCrypto: session ${sessionId}'s DEK failed to unwrap`);
      }
      setReady(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, dek, sessionId]);

  return ready ? bridge : null;
}
