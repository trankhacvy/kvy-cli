"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { GitDiffActions } from "./types";

/**
 * The Git panel's data-fetching state (falcon-prd.md FR-7.7): `git.status`
 * once per `worktree`, then `git.diff` re-fetched whenever the selected
 * file (or `baseRef` override) changes. `selectedPath: null` means "diff
 * every changed file at once" — `ChangedFilesList`'s "All files" row.
 *
 * Plain `useQuery` (not the sync engine's invalidate-on-update machinery —
 * see `sync/queryKeys.ts`'s doc comment): the Git panel has no server-side
 * push channel of its own, it's a point-in-time RPC snapshot the user
 * refreshes by re-selecting or explicit re-fetch, same as `features/
 * new-session`'s directory picker.
 */
export function useGitPanel(actions: GitDiffActions, worktree: string) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ["git-status", worktree],
    queryFn: () => actions.fetchStatus(worktree),
  });

  const diffQuery = useQuery({
    queryKey: ["git-diff", worktree, selectedPath],
    queryFn: () => actions.fetchDiff(worktree, selectedPath ? { path: selectedPath } : undefined),
    // Nothing to diff until the file list has actually loaded — avoids an
    // "all files" fetch racing ahead of `git.status` on first mount.
    enabled: statusQuery.isSuccess,
  });

  return {
    status: statusQuery.data,
    statusError: statusQuery.error instanceof Error ? statusQuery.error.message : null,
    isStatusLoading: statusQuery.isLoading,
    selectedPath,
    selectFile: setSelectedPath,
    diff: diffQuery.data,
    diffError: diffQuery.error instanceof Error ? diffQuery.error.message : null,
    isDiffLoading: diffQuery.isLoading || diffQuery.isFetching,
  };
}
