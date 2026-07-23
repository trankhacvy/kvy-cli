"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MachineSettingsActions, SleepInhibitMode, SleepInhibitState } from "./types";

function queryKey(machineId: string) {
  return ["machine-settings", "sleep-inhibit", machineId] as const;
}

/**
 * The Sleep Inhibit card's data-fetching + write-action state
 * (docs/features/sleep-inhibit.md) — mirrors `features/provider-accounts/
 * use-provider-account.ts`'s shape: a plain `useQuery` (this has no
 * server-side push channel of its own, it's a point-in-time RPC snapshot),
 * plus a `useMutation` for `setSleepInhibit`.
 *
 * The mutation writes its result straight into the query cache via
 * `setQueryData` rather than invalidating — `sleepInhibit.set`'s wire
 * contract already returns the full post-apply `SleepInhibitState` (same
 * "no follow-up get needed" design as `git.commit`'s own result), so a
 * round-trip re-fetch would just ask the daemon to tell us the same thing
 * again.
 */
export function useMachineSettings(actions: MachineSettingsActions, machineId: string) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKey(machineId),
    queryFn: () => actions.fetchSleepInhibit(),
  });

  const mutation = useMutation({
    mutationFn: (mode: SleepInhibitMode) => actions.setSleepInhibit(mode),
    onSuccess: (state: SleepInhibitState) => {
      queryClient.setQueryData(queryKey(machineId), state);
    },
  });

  return {
    state: query.data,
    error: query.error instanceof Error ? query.error.message : null,
    isLoading: query.isLoading,
    // `isFetching && !isLoading` — true only for an explicit re-fetch of
    // already-loaded data, same derivation as `use-provider-account.ts`'s
    // own `isRefreshing`.
    isRefreshing: query.isFetching && !query.isLoading,
    isSaving: mutation.isPending,
    saveError: mutation.error instanceof Error ? mutation.error.message : null,
    setMode: (mode: SleepInhibitMode) => mutation.mutate(mode),
  };
}
