"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { getSync } from "@/lib/api";
import { getToken } from "@/lib/session";
import { apiSocket, createSyncEngine, syncQueryKey } from "@/sync";

/**
 * Keeps the `['sync']` account snapshot populated and wires the sync engine to
 * `apiSocket` for the calling component's lifetime. Safe to mount from multiple
 * components: `apiSocket.connect` is idempotent, and each extra `createSyncEngine`
 * instance just observes the same `QueryClient` cache redundantly.
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
