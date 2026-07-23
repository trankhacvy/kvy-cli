"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { archiveSession, deleteSession, unarchiveSession } from "@/lib/api";
import { getToken } from "@/lib/session";
import type { SyncSnapshot } from "@/sync";
import { syncQueryKey } from "@/sync";

/**
 * Archive/delete session actions (plan-v2.md W4.2 "Archive/delete: … wire
 * buttons on Home rows + session header, TanStack mutations, optimistic
 * removal"). Shared by `features/session-list`'s `SessionCard` and the
 * timeline header (`SessionTimelineScreen`) — the only two call sites that
 * need to end a session's *presence in the list*, as distinct from W2.3's
 * `stop` RPC which ends the underlying process.
 *
 * Both mutations patch the `['sync']` snapshot cache optimistically
 * (`onMutate`) and roll back on failure (`onError`) — the live
 * `session-update`/`session-delete` WS fan-out `sync/engine.ts` already
 * handles (this same account's own connection is `all-interested-in-session`
 * for both routes) arrives moments later and reconciles to the same state,
 * so this is a perceived-latency optimization, not the only path to
 * correctness.
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

/** Restore (docs/features/session-lifecycle-actions.md Phase 5) — the
 * inverse of `useArchiveSessionMutation`, structural clone of it against
 * `unarchiveSession`. Optimistically flips the cached row back to `active`;
 * the server's own honest current-status response (a non-archived row is
 * left untouched server-side) reconciles on success, and the live
 * `session-update` fan-out arrives moments later either way. */
export function useRestoreSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const token = getToken();
      if (!token) throw new Error("Not signed in");
      return unarchiveSession(token, sessionId);
    },
    onMutate: async (sessionId: string) => {
      const previous = snapshotSessions(queryClient);
      queryClient.setQueryData<SyncSnapshot>(syncQueryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          sessions: old.sessions.map((s) =>
            s.id === sessionId ? { ...s, status: "active" as const } : s,
          ),
        };
      });
      return { previous };
    },
    onError: (error, _sessionId, context) => {
      if (context?.previous) queryClient.setQueryData(syncQueryKey, context.previous);
      toast.error(error instanceof Error ? error.message : "Could not restore the session.");
    },
    onSuccess: () => {
      toast.success("Session restored.");
    },
  });
}

export function useDeleteSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const token = getToken();
      if (!token) throw new Error("Not signed in");
      return deleteSession(token, sessionId);
    },
    onMutate: async (sessionId: string) => {
      const previous = snapshotSessions(queryClient);
      queryClient.setQueryData<SyncSnapshot>(syncQueryKey, (old) => {
        if (!old) return old;
        return { ...old, sessions: old.sessions.filter((s) => s.id !== sessionId) };
      });
      return { previous };
    },
    onError: (error, _sessionId, context) => {
      if (context?.previous) queryClient.setQueryData(syncQueryKey, context.previous);
      toast.error(error instanceof Error ? error.message : "Could not delete the session.");
    },
    onSuccess: () => {
      toast.success("Session deleted.");
    },
  });
}
