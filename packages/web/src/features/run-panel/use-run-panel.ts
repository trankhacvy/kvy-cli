"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunPanelActions, RunStatusSnapshot } from "./types";

/**
 * The Setup/Run panel's data-fetching + control state (docs/features/
 * setup-run-scripts.md Phase 5): `workspace.getConfig` fetched once per
 * `worktree` (the configured scripts don't change while the panel is open —
 * they're only ever edited from a terminal), and `run.status` polled while
 * *either* the run process or a setup run is actually active, so play/stop
 * state and the log tail stay live without polling forever once everything
 * is idle.
 *
 * `start`/`stop`/`setup` each invalidate the `run-status` query on settle
 * (success OR failure — even a failed start attempt might have raced a
 * status change, so re-fetching is always safe and cheap here).
 */
function isActive(status: RunStatusSnapshot | undefined): boolean {
  return status?.run.state === "running" || status?.setup.state === "running";
}

export function useRunPanel(actions: RunPanelActions, worktree: string) {
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: ["run-config", worktree],
    queryFn: () => actions.getConfig(worktree),
  });

  const statusQuery = useQuery({
    queryKey: ["run-status", worktree],
    queryFn: () => actions.status(worktree),
    refetchInterval: (query) => (isActive(query.state.data) ? 5000 : false),
  });

  function invalidateStatus(): void {
    void queryClient.invalidateQueries({ queryKey: ["run-status", worktree] });
  }

  const startMutation = useMutation({
    mutationFn: () => actions.start(worktree),
    onSettled: invalidateStatus,
  });

  const stopMutation = useMutation({
    mutationFn: () => actions.stop(worktree),
    onSettled: invalidateStatus,
  });

  const setupMutation = useMutation({
    mutationFn: () => actions.setup(worktree),
    onSettled: invalidateStatus,
  });

  return {
    config: configQuery.data,
    isConfigLoading: configQuery.isLoading,
    configError: configQuery.error instanceof Error ? configQuery.error.message : null,

    status: statusQuery.data,
    isStatusLoading: statusQuery.isLoading,
    statusError: statusQuery.error instanceof Error ? statusQuery.error.message : null,

    start: startMutation.mutate,
    isStartPending: startMutation.isPending,
    startError: startMutation.error instanceof Error ? startMutation.error.message : null,

    stop: stopMutation.mutate,
    isStopPending: stopMutation.isPending,
    stopError: stopMutation.error instanceof Error ? stopMutation.error.message : null,

    setup: setupMutation.mutate,
    isSetupPending: setupMutation.isPending,
    setupError: setupMutation.error instanceof Error ? setupMutation.error.message : null,
  };
}

/** The shape `RunPanel` consumes — passed straight through from this hook. */
export type RunPanelState = ReturnType<typeof useRunPanel>;
