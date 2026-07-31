"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { archiveSession } from "@/lib/api";
import { getToken } from "@/lib/session";
import type { SyncSnapshot } from "@/sync";
import { syncQueryKey } from "@/sync";

/**
 * Archive session action — the single lifecycle mutation (conductor.build's
 * model: no separate stop/restart/delete/restore). Shared by
 * `features/session-list`'s `SessionCard` and the timeline header
 * (`SessionTimelineScreen`) via `ArchiveSessionDialog`/`useArchiveSession`.
 *
 * Optimistically patches the `['sync']` snapshot cache (`onMutate`) and
 * rolls back on failure (`onError`) — the live `session-update` WS fan-out
 * `sync/engine.ts` already handles arrives moments later and reconciles to
 * the same state, so this is a perceived-latency optimization, not the only
 * path to correctness.
 */

function snapshotSessions(
  queryClient: ReturnType<typeof useQueryClient>,
): SyncSnapshot | undefined {
  return queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
}

export function useArchiveSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const token = getToken();
      if (!token) throw new Error("Not signed in");
      return archiveSession(token, sessionId);
    },
    onMutate: async (sessionId: string) => {
      const previous = snapshotSessions(queryClient);
      queryClient.setQueryData<SyncSnapshot>(syncQueryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          sessions: old.sessions.map((s) =>
            s.id === sessionId ? { ...s, status: "archived" as const } : s,
          ),
        };
      });
      return { previous };
    },
    onError: (error, _sessionId, context) => {
      if (context?.previous) queryClient.setQueryData(syncQueryKey, context.previous);
      toast.error(error instanceof Error ? error.message : "Could not archive the session.");
    },
    onSuccess: () => {
      toast.success("Session archived.");
    },
  });
}
