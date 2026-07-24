"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { buildDiffFetchOptions } from "./git-diff-query";
import type { GitDiffActions } from "./types";

/**
 * The Git panel's data-fetching + write-action state (falcon-prd.md FR-7.7;
 * docs/features/git-write-actions.md): `git.status` once per `worktree`,
 * `git.diff` re-fetched whenever the selected file or `compareRef` changes,
 * and `git.branches` for the "Compare against" selector's branch options.
 * `selectedPath: null` means "diff every changed file at once" —
 * `ChangedFilesList`'s "All files" row. `compareRef: null` means "use the
 * workspace's configured base ref" (daemon-side fallback in
 * `gitDiff.ts`'s `resolveConfiguredBaseRef`) — any string, including
 * `"HEAD"`, is passed straight through as an explicit `baseRef` override.
 *
 * Plain `useQuery` (not the sync engine's invalidate-on-update machinery —
 * see `sync/queryKeys.ts`'s doc comment): the Git panel has no server-side
 * push channel of its own, it's a point-in-time RPC snapshot the user
 * refreshes by re-selecting, mutating, or explicit re-fetch, same as
 * `features/new-session`'s directory picker.
 *
 * The three write mutations (`commit`/`push`/`renameBranch`, mirroring
 * `components/timeline/ComposerControls.tsx`'s `useMutation` shape) each
 * invalidate `["git-status", worktree]` and `["git-diff", worktree]` (a
 * prefix match — TanStack Query invalidates every query whose key starts
 * with the given array, so this covers every `selectedPath`/`compareRef`
 * combination already cached) on success; `renameBranch` additionally
 * invalidates `["git-branches", worktree]` since the current-branch flag
 * moves.
 */
/**
 * Duck-types out a thrown error's optional `handlerErrorCode` (known-issues.md
 * #3) without this hook depending on the concrete `MachineRpcError` class —
 * `GitDiffActions` is the seam that keeps this hook transport-agnostic
 * (mock vs. live), and a mock action's plain `Error` simply has no such
 * property, so this safely resolves to `undefined` for it.
 */
function handlerErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "handlerErrorCode" in error) {
    const value = (error as { handlerErrorCode?: unknown }).handlerErrorCode;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

export function useGitPanel(actions: GitDiffActions, worktree: string) {
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [compareRef, setCompareRef] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ["git-status", worktree],
    queryFn: () => actions.fetchStatus(worktree),
  });

  const diffQuery = useQuery({
    queryKey: ["git-diff", worktree, selectedPath, compareRef],
    queryFn: () => actions.fetchDiff(worktree, buildDiffFetchOptions(selectedPath, compareRef)),
    // Nothing to diff until the file list has actually loaded — avoids an
    // "all files" fetch racing ahead of `git.status` on first mount.
    enabled: statusQuery.isSuccess,
  });

  const branchesQuery = useQuery({
    queryKey: ["git-branches", worktree],
    queryFn: () => actions.listBranches(worktree),
    enabled: statusQuery.isSuccess,
  });

  function invalidateStatusAndDiff(): void {
    void queryClient.invalidateQueries({ queryKey: ["git-status", worktree] });
    void queryClient.invalidateQueries({ queryKey: ["git-diff", worktree] });
  }

  const commitMutation = useMutation({
    mutationFn: ({ message, stageAll }: { message: string; stageAll?: boolean }) =>
      actions.commit(worktree, message, { stageAll }),
    onSuccess: invalidateStatusAndDiff,
  });

  const pushMutation = useMutation({
    mutationFn: (options?: { force?: boolean; setUpstream?: boolean }) =>
      actions.push(worktree, options),
    onSuccess: invalidateStatusAndDiff,
  });

  const renameBranchMutation = useMutation({
    mutationFn: (to: string) => actions.renameBranch(worktree, to),
    onSuccess: () => {
      invalidateStatusAndDiff();
      void queryClient.invalidateQueries({ queryKey: ["git-branches", worktree] });
    },
  });

  // known-issues.md #3: offered once `statusErrorCode`/`diffErrorCode` is
  // "workspace-missing"/"workspace-not-a-repo" — removes the stale registry
  // entry so it stops showing up as a broken workspace everywhere else too.
  const removeWorkspaceMutation = useMutation({
    mutationFn: () => actions.unregisterWorkspace(worktree),
  });

  return {
    status: statusQuery.data,
    statusError: statusQuery.error instanceof Error ? statusQuery.error.message : null,
    statusErrorCode: handlerErrorCode(statusQuery.error),
    isStatusLoading: statusQuery.isLoading,
    selectedPath,
    selectFile: setSelectedPath,
    diff: diffQuery.data,
    diffError: diffQuery.error instanceof Error ? diffQuery.error.message : null,
    diffErrorCode: handlerErrorCode(diffQuery.error),
    isDiffLoading: diffQuery.isLoading || diffQuery.isFetching,

    removeWorkspace: removeWorkspaceMutation.mutate,
    isRemoveWorkspacePending: removeWorkspaceMutation.isPending,
    removeWorkspaceDone: removeWorkspaceMutation.isSuccess,

    compareRef,
    setCompareRef,
    branches: branchesQuery.data ?? [],
    isBranchesLoading: branchesQuery.isLoading,

    commit: commitMutation.mutate,
    isCommitPending: commitMutation.isPending,
    commitError: commitMutation.error instanceof Error ? commitMutation.error.message : null,
    commitResult: commitMutation.data,

    push: pushMutation.mutate,
    isPushPending: pushMutation.isPending,
    pushError: pushMutation.error instanceof Error ? pushMutation.error.message : null,

    renameBranch: renameBranchMutation.mutate,
    isRenameBranchPending: renameBranchMutation.isPending,
    renameBranchError:
      renameBranchMutation.error instanceof Error ? renameBranchMutation.error.message : null,
    renameBranchResult: renameBranchMutation.data,
  };
}

/** The shape `GitToolbar`/`CompareAgainstSelect` consume — passed straight through from `GitDiffPanel`'s call to this hook. */
export type GitPanelState = ReturnType<typeof useGitPanel>;
