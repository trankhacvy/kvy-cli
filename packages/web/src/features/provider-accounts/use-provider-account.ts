"use client";

import { useQuery } from "@tanstack/react-query";
import type { ProviderAccountActions, ProviderAccountProvider } from "./types";

/**
 * One provider card's data-fetching state (docs/competitive-notes-omnara.md
 * #9: "live, refreshable account metadata"). Plain `useQuery` — mirrors
 * `features/git-diff/use-git-panel.ts`'s own doc comment: this has no
 * server-side push channel of its own, it's a point-in-time RPC snapshot the
 * user refreshes explicitly (the card's refresh button), not the sync
 * engine's invalidate-on-update machinery.
 */
export function useProviderAccount(
  actions: ProviderAccountActions,
  machineId: string,
  provider: ProviderAccountProvider,
) {
  const query = useQuery({
    queryKey: ["provider-account", machineId, provider],
    queryFn: () => actions.fetchAccount(provider),
  });

  return {
    account: query.data,
    error: query.error instanceof Error ? query.error.message : null,
    isLoading: query.isLoading,
    // `isFetching && !isLoading` — true only for an explicit re-fetch of
    // already-loaded data, so the refresh button's spinner doesn't also
    // fire during the very first load (that's `isLoading`'s own skeleton).
    isRefreshing: query.isFetching && !query.isLoading,
    refresh: () => query.refetch(),
  };
}
