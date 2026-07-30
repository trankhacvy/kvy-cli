"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRefetchOnMachineRecovery } from "@/lib/use-refetch-on-machine-recovery";
import type { PreviewActions, PreviewPortsSnapshot } from "./types";

/** Pure derivation, extracted for a direct render-free test — mirrors `git-diff-query.ts`'s `buildDiffFetchOptions` precedent (`use-git-panel.test.ts`'s own doc comment on why: no jsdom re-render wired up in this package's vitest config). `undefined` (query hasn't resolved yet) means "don't know yet", not "missing" — showing the banner before the first successful fetch would be a false positive. */
export function deriveCloudflaredMissing(ports: PreviewPortsSnapshot | undefined): boolean {
  return ports ? !ports.cloudflared.installed : false;
}

/**
 * The Preview tab's data-fetching + open/close mutation state
 * (docs/features/dev-server-preview.md). Polling MVP, same "no server-side
 * push channel of its own" reasoning as `use-git-panel.ts`/
 * `use-checks-panel.ts` — the reserved `preview:*` ephemeral-streaming
 * namespace (`@falcon/wire`'s `reserved.ts`) is the real fix for live
 * tunnel-liveness updates, deferred to a later phase.
 *
 * Two independent polling intervals, not one shared fetch: `preview.ports`
 * (15s) rarely changes — a dev server doesn't start/stop every few
 * seconds — while `preview.tunnels` (5s) is the one thing this tab actually
 * needs to feel "live" (a tunnel becoming active, or a `cloudflared` child
 * crashing on its own between clicks).
 *
 * Query keys are scoped by `machineId` (`['preview-ports', machineId]` /
 * `['preview-tunnels', machineId]`) — even though `actions` is itself
 * already bound to one machine, an unscoped key would let a user who
 * switches the Preview tab between two machines without a full remount see
 * one machine's stale ports/tunnels cached under the other's.
 */
export function usePreviewPanel(actions: PreviewActions, machineId: string, machineOnline = true) {
  const queryClient = useQueryClient();
  const portsQueryKey = ["preview-ports", machineId];
  const tunnelsQueryKey = ["preview-tunnels", machineId];

  const portsQuery = useQuery({
    queryKey: portsQueryKey,
    queryFn: () => actions.fetchPorts(),
    refetchInterval: 15_000,
  });

  const tunnelsQuery = useQuery({
    queryKey: tunnelsQueryKey,
    queryFn: () => actions.fetchTunnels(),
    refetchInterval: 5_000,
  });

  function invalidateAll(): void {
    void queryClient.invalidateQueries({ queryKey: portsQueryKey });
    void queryClient.invalidateQueries({ queryKey: tunnelsQueryKey });
  }

  useRefetchOnMachineRecovery(machineOnline, invalidateAll);

  const openMutation = useMutation({
    mutationFn: (port: number) => actions.openTunnel(port),
    onSuccess: invalidateAll,
  });

  const closeMutation = useMutation({
    mutationFn: (tunnelId: string) => actions.closeTunnel(tunnelId),
    onSuccess: invalidateAll,
  });

  return {
    ports: portsQuery.data?.ports ?? [],
    cloudflaredMissing: deriveCloudflaredMissing(portsQuery.data),
    isPortsLoading: portsQuery.isLoading,
    portsError: portsQuery.error instanceof Error ? portsQuery.error.message : null,

    tunnels: tunnelsQuery.data ?? [],
    isTunnelsLoading: tunnelsQuery.isLoading,

    openTunnel: openMutation.mutate,
    isOpenPending: openMutation.isPending,
    openError: openMutation.error instanceof Error ? openMutation.error.message : null,
    resetOpenError: openMutation.reset,

    closeTunnel: closeMutation.mutate,
    isClosePending: closeMutation.isPending,
    closeError: closeMutation.error instanceof Error ? closeMutation.error.message : null,
  };
}

/** The shape `PreviewPanel`/`PortsList`/`OpenTunnelConfirmDialog` consume. */
export type PreviewPanelState = ReturnType<typeof usePreviewPanel>;
