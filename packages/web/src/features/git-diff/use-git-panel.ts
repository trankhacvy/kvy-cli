"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRefetchOnMachineRecovery } from "@/lib/use-refetch-on-machine-recovery";
import { useRefetchOnTurnEnd } from "@/lib/use-refetch-on-turn-end";
import { buildDiffFetchOptions } from "./git-diff-query";
import { derivePushReadiness } from "./push-readiness";
import type { GitDiffActions } from "./types";

/**
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

/**
 * build that knows `git.init` talking to an older daemon gets back the
 * literal `"unknown-method"` (`machineRpc.ts`'s uniform unknown-method
 * error box) — translated here into copy that reads like a version-skew
 * hint rather than a bug, same precedent as `inline-spawn.ts`'s
 * `translateSpawnError`. Every other message passes through unchanged.
 */
export function translateInitRepoError(raw: string): string {
  if (raw === "unknown-method") {
    return "This machine is running an older version of Kvy. Update it there and try again.";
  }
  return raw;
}

// A file changed outside the agent entirely — the user editing in their own
// terminal/editor — has no signal this panel can react to at all (unlike
// `useRefetchOnTurnEnd`, which only ever fires off the AGENT's own turns).
// Polling is the deliberately simple fallback for that gap (see the design
// discussion this constant's PR resolves): a real filesystem watcher pushed
// through the daemon/server relay is "more correct" but a lot of new
// plumbing (watcher lifecycle per workspace, debouncing, `.gitignore`-aware
// exclusion) for what's actually a narrow case — most file changes come from
// the agent and are already covered live. Only polls while the machine is
// online; an offline machine's RPC would just fail every interval for
// nothing.
const LIVE_REFRESH_POLL_INTERVAL_MS = 7_000;

export function useGitPanel(
  actions: GitDiffActions,
  worktree: string,
  machineOnline = true,
  working = false,
) {
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [compareRef, setCompareRef] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ["git-status", worktree],
    queryFn: () => actions.fetchStatus(worktree),
    refetchInterval: machineOnline ? LIVE_REFRESH_POLL_INTERVAL_MS : false,
  });

  const diffQuery = useQuery({
    queryKey: ["git-diff", worktree, selectedPath, compareRef],
    queryFn: () => actions.fetchDiff(worktree, buildDiffFetchOptions(selectedPath, compareRef)),
    // Nothing to diff until the file list has actually loaded — avoids an
    // "all files" fetch racing ahead of `git.status` on first mount.
    enabled: statusQuery.isSuccess,
    refetchInterval: machineOnline ? LIVE_REFRESH_POLL_INTERVAL_MS : false,
  });

  const branchesQuery = useQuery({
    queryKey: ["git-branches", worktree],
    queryFn: () => actions.listBranches(worktree),
    enabled: statusQuery.isSuccess,
  });

  const remotesQuery = useQuery({
    queryKey: ["git-remotes", worktree],
    queryFn: () => actions.listRemotes(worktree),
    enabled: statusQuery.isSuccess,
  });

  function invalidateStatusAndDiff(): void {
    void queryClient.invalidateQueries({ queryKey: ["git-status", worktree] });
    void queryClient.invalidateQueries({ queryKey: ["git-diff", worktree] });
  }

  // `actions` starts out as a permanently-rejecting stub until this
  // machine's crypto key finishes unwrapping (`useLiveGitDiffActions`). The
  // very first fetch attempt, made against that stub, can settle into a
  // state TanStack Query never automatically retries — nothing re-runs it
  // once `actions` is swapped for the real client, so the panel can get
  // stuck showing "Could not load git status" even after the machine key is
  // ready. Force a refetch the moment `actions`'s identity changes after
  // mount — that's exactly when the stub gets replaced by the real one.
  const isFirstActionsRender = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed only on `actions` — this effect exists purely to notice the stub→real swap, not to re-run for every `worktree`/`queryClient` change (those are already handled by the queries' own `queryKey`s).
  useEffect(() => {
    if (isFirstActionsRender.current) {
      isFirstActionsRender.current = false;
      return;
    }
    invalidateStatusAndDiff();
    void queryClient.invalidateQueries({ queryKey: ["git-branches", worktree] });
    void queryClient.invalidateQueries({ queryKey: ["git-remotes", worktree] });
  }, [actions]);

  useRefetchOnMachineRecovery(machineOnline, () => {
    invalidateStatusAndDiff();
    void queryClient.invalidateQueries({ queryKey: ["git-branches", worktree] });
    void queryClient.invalidateQueries({ queryKey: ["git-remotes", worktree] });
  });

  // The agent's own Write/Edit/Bash tool calls change files on disk without
  // ever touching these queries — only a manual git action did before this.
  // Refetching once each turn ends is the cheapest honest "something might
  // have changed" signal available (`use-refetch-on-turn-end.ts`).
  useRefetchOnTurnEnd(working, invalidateStatusAndDiff);

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

  const commitAndPush = useCallback(
    async (params: { message: string; stageAll?: boolean }) => {
      const result = await commitMutation.mutateAsync(params);
      if (result.nothingToCommit) return { ...result, pushed: false as const };
      // If this throws, the caller sees a rejected promise — `committed: true`
      // already happened and stays true; the UI must show "committed, but push
      // failed" (via `pushMutation.error`, already exposed), never silently
      // re-attempt the commit or claim the combined action fully succeeded.
      await pushMutation.mutateAsync({});
      return { ...result, pushed: true as const };
    },
    [commitMutation, pushMutation],
  );

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

  // Feature 1 (docs/web-ux-improvements-plan.md): offered when
  // `statusErrorCode` is "workspace-not-a-repo" — a real folder that was
  // simply never `git init`ed. Invalidates status/diff/branches/remotes on
  // success so the panel flips straight from the error state to a live repo
  // with no manual refresh (CLAUDE.md rule #6); a refused
  // "inside-existing-repo" result changed nothing daemon-side, so nothing
  // is invalidated for it.
  const initRepoMutation = useMutation({
    mutationFn: () => actions.initRepo(worktree),
    onSuccess: (result) => {
      if (result.state === "inside-existing-repo") return;
      invalidateStatusAndDiff();
      void queryClient.invalidateQueries({ queryKey: ["git-branches", worktree] });
      void queryClient.invalidateQueries({ queryKey: ["git-remotes", worktree] });
    },
  });

  const setRemoteMutation = useMutation({
    mutationFn: ({ url, name }: { url: string; name?: string }) =>
      actions.setRemote(worktree, url, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["git-remotes", worktree] });
      void queryClient.invalidateQueries({ queryKey: ["git-status", worktree] });
    },
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

    remotes: remotesQuery.data,
    pushReadiness: derivePushReadiness(
      statusQuery.data,
      remotesQuery.data,
      branchesQuery.data ?? [],
    ),

    initRepo: initRepoMutation.mutate,
    isInitRepoPending: initRepoMutation.isPending,
    initRepoError:
      initRepoMutation.error instanceof Error
        ? translateInitRepoError(initRepoMutation.error.message)
        : null,
    initRepoResult: initRepoMutation.data,

    setRemote: setRemoteMutation.mutate,
    isSetRemotePending: setRemoteMutation.isPending,
    setRemoteError:
      setRemoteMutation.error instanceof Error ? setRemoteMutation.error.message : null,

    commit: commitMutation.mutate,
    isCommitPending: commitMutation.isPending,
    commitError: commitMutation.error instanceof Error ? commitMutation.error.message : null,
    commitResult: commitMutation.data,

    push: pushMutation.mutate,
    isPushPending: pushMutation.isPending,
    pushError: pushMutation.error instanceof Error ? pushMutation.error.message : null,

    commitAndPush,
    isCommitAndPushPending: commitMutation.isPending || pushMutation.isPending,

    renameBranch: renameBranchMutation.mutate,
    isRenameBranchPending: renameBranchMutation.isPending,
    renameBranchError:
      renameBranchMutation.error instanceof Error ? renameBranchMutation.error.message : null,
    renameBranchResult: renameBranchMutation.data,
  };
}

/** The shape `GitToolbar`/`CompareAgainstSelect` consume — passed straight through from `GitDiffPanel`'s call to this hook. */
export type GitPanelState = ReturnType<typeof useGitPanel>;
