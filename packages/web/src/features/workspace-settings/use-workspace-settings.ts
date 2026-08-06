"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createWorkspace, putWorkspaceMetadataCas } from "@/lib/api";
import { getToken } from "@/lib/session";
import { useDedicatedCryptoBridge } from "@/lib/use-crypto-bridge";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { saveWorkspaceServerConfig } from "./server-config.js";
import type {
  WorkspaceGitConfig,
  WorkspaceGitConfigPatch,
  WorkspaceSettingsActions,
} from "./types.js";

/**
 * Workspace Settings dialog's Git tab data — structural clone of
 * `features/run-panel/use-run-panel.ts`'s React Query wiring, plus a second
 * write path `save()` fans out to: the daemon (`actions.setConfig`, the
 * config that actually governs local git operations) AND, best-effort, the
 * server-synced `workspaces` row (`saveWorkspaceServerConfig`) so the
 * dialog reads correctly even when the daemon/machine is offline. A server
 * sync failure doesn't fail the save — the daemon write already succeeded
 * and is the one that matters for local git behavior — it's surfaced as a
 * toast instead.
 */
export function useWorkspaceSettings(actions: WorkspaceSettingsActions, worktree: string) {
  const queryClient = useQueryClient();
  const snapshot = useSyncSnapshotQuery();
  const bridge = useDedicatedCryptoBridge();

  const configQuery = useQuery({
    queryKey: ["workspace-config", worktree],
    queryFn: () => actions.getConfig(worktree),
  });

  const branchesQuery = useQuery({
    queryKey: ["workspace-branches", worktree],
    queryFn: () => actions.listBranches(worktree),
  });

  const remotesQuery = useQuery({
    queryKey: ["workspace-remotes", worktree],
    queryFn: () => actions.listRemotes(worktree),
  });

  const saveMutation = useMutation({
    mutationFn: async (patch: WorkspaceGitConfigPatch) => {
      const result = await actions.setConfig(worktree, patch);

      const token = getToken();
      if (token && bridge) {
        // Never compare against a plaintext `path` — the server doesn't
        // return one. `pathHash` is the same create-or-get key `POST
        // /v1/workspaces` itself uses, computed the same way (`server-config.ts`).
        const pathHash = await bridge.hashWorkspacePath(worktree);
        const existing = snapshot.data?.workspaces.find((w) => w.pathHash === pathHash);
        try {
          await saveWorkspaceServerConfig(
            {
              bridge,
              createWorkspace,
              putMetadataCas: putWorkspaceMetadataCas,
              token,
              path: worktree,
            },
            existing,
            (current) => ({ ...current, ...patch }),
          );
        } catch (err) {
          console.error("useWorkspaceSettings: server-side config sync failed", err);
          toast.error("Saved locally, but couldn't sync this to the server.");
        }
      }

      return result;
    },
    onSuccess: (result) => {
      queryClient.setQueryData<WorkspaceGitConfig>(["workspace-config", worktree], (old) => ({
        ...old,
        ...result,
      }));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not save changes.");
    },
  });

  return {
    config: configQuery.data,
    isConfigLoading: configQuery.isLoading,
    configError: configQuery.error instanceof Error ? configQuery.error.message : null,
    branches: branchesQuery.data,
    isBranchesLoading: branchesQuery.isLoading,
    remotes: remotesQuery.data,
    isRemotesLoading: remotesQuery.isLoading,
    save: saveMutation.mutate,
    isSavePending: saveMutation.isPending,
    saveError: saveMutation.error instanceof Error ? saveMutation.error.message : null,
  };
}

export type WorkspaceSettingsState = ReturnType<typeof useWorkspaceSettings>;
