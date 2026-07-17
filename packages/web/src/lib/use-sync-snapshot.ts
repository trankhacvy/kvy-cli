"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { getSync } from "@/lib/api";
import { getToken } from "@/lib/session";
import { apiSocket, createSyncEngine, syncQueryKey } from "@/sync";

/**
 * Keeps the `['sync']` account snapshot populated + live (design §4.3/§9.1)
 * and wires the sync engine to `apiSocket` for the lifetime of the calling
 * component — the shared call site that actually connects the pair
 * `sync/index.ts`'s own docstring describes:
 *
 *   const engine = createSyncEngine(queryClient, apiSocket);
 *
 * Extracted out of `features/session-control/use-session-crypto.ts` (its
 * original, single call site) once `features/session-list`'s live data
 * source (`live-source.ts`) needed the same account snapshot — both features
 * read the same `['sync']` cache, so there should only ever be one place
 * that owns fetching + engine wiring for it. Safe to mount from more than
 * one component at a time: `apiSocket.connect` is an idempotent no-op for an
 * already-connected token, and each extra `createSyncEngine` instance just
 * redundantly observes the same `QueryClient` cache, per that module's own
 * gap-invalidation design.
 */
export function useSyncSnapshotQuery() {
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
