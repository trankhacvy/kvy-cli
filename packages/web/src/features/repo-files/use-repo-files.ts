"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRefetchOnMachineRecovery } from "@/lib/use-refetch-on-machine-recovery";
import { useRefetchOnTurnEnd } from "@/lib/use-refetch-on-turn-end";
import { appendPage, type PagedFileContent } from "./file-content-paging";
import { buildFileTree } from "./file-tree-logic";
import type { RepoFilesActions } from "./types";

/** Bytes requested per "Load more" page — matches `fsRead.ts`'s own `MAX_INLINE_BYTES` budget, so one click's worth of range request is exactly one more inline-sized page. */
const PAGE_SIZE_BYTES = 60_000;

/** Same gap/fix as `use-git-panel.ts`'s own constant of this name: a file changed outside the agent (the user editing in their own terminal) never invalidates this query on its own, so poll for it — see that file's doc comment for why polling over a real filesystem watcher. */
const LIVE_REFRESH_POLL_INTERVAL_MS = 7_000;

/**
 * The Repo Files panel's data-fetching state (docs/competitive-notes-
 * omnara.md #5): `git.files` once per `worktree` to build the tree, then
 * `fs.read` re-fetched whenever the selected file changes. Mirrors
 * `features/git-diff/use-git-panel.ts`'s shape exactly — plain `useQuery`
 * (not the sync engine's invalidate-on-update machinery), a point-in-time
 * RPC snapshot the user refreshes by re-selecting or explicit re-fetch.
 */
export function useRepoFiles(
  actions: RepoFilesActions,
  worktree: string,
  machineOnline = true,
  working = false,
) {
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const filesQuery = useQuery({
    queryKey: ["repo-files", worktree],
    queryFn: () => actions.fetchFileList(worktree),
    refetchInterval: machineOnline ? LIVE_REFRESH_POLL_INTERVAL_MS : false,
  });

  const contentQuery = useQuery({
    queryKey: ["repo-file-content", worktree, selectedPath],
    queryFn: () => actions.fetchFileContent(worktree, selectedPath as string),
    // Nothing to fetch until a file is actually selected — mirrors
    // `use-git-panel.ts`'s "avoid a race with the file list" enabled guard.
    enabled: selectedPath !== null,
  });

  // Feature 3 Phase 5 (docs/web-ux-improvements-plan.md): `contentQuery`
  // above always represents just the FIRST page (no `range`) of whatever
  // file is selected. `pagedContent` accumulates it plus every subsequent
  // `loadMoreMutation` page through `appendPage` — reset to `null`
  // immediately on a path change (so a slow-loading new file never shows
  // the previous file's tail), then re-seeded once that new first page
  // actually lands (including on any refetch of it, e.g. the machine-
  // recovery invalidation above — `firstPageUpdatedAtRef` tracks that by
  // `dataUpdatedAt`, not just presence).
  const [pagedContent, setPagedContent] = useState<PagedFileContent | null>(null);
  const firstPageUpdatedAtRef = useRef<number | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on `selectedPath` even though the body doesn't read it — this effect exists purely to reset `pagedContent` the moment the selected file changes, before the new file's first page has landed.
  useEffect(() => {
    setPagedContent(null);
  }, [selectedPath]);

  useEffect(() => {
    if (!contentQuery.data) return;
    if (contentQuery.dataUpdatedAt === firstPageUpdatedAtRef.current) return;
    firstPageUpdatedAtRef.current = contentQuery.dataUpdatedAt;
    setPagedContent(
      appendPage(null, {
        inline: contentQuery.data.inline,
        truncated: contentQuery.data.truncated,
      }),
    );
  }, [contentQuery.data, contentQuery.dataUpdatedAt]);

  const loadMoreMutation = useMutation({
    mutationFn: async () => {
      if (selectedPath === null || pagedContent === null) {
        throw new Error("no file content loaded yet to page beyond");
      }
      const range = {
        start: pagedContent.loadedBytes,
        end: pagedContent.loadedBytes + PAGE_SIZE_BYTES,
      };
      return actions.fetchFileContent(worktree, selectedPath, range);
    },
    onSuccess: (page) => {
      setPagedContent((prev) =>
        appendPage(prev, { inline: page.inline, truncated: page.truncated }),
      );
    },
  });

  // `actions` starts out as a permanently-rejecting stub until this
  // machine's crypto key finishes unwrapping (`useLiveRepoFilesActions`) —
  // a fetch raced against that stub can get stuck in a state nothing
  // retries once `actions` is swapped for the real client. Force a refetch
  // the moment `actions`'s identity changes after mount, the same fix
  // `use-git-panel.ts` applies.
  const isFirstActionsRender = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed only on `actions` — see use-git-panel.ts's identical effect.
  useEffect(() => {
    if (isFirstActionsRender.current) {
      isFirstActionsRender.current = false;
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["repo-files", worktree] });
    void queryClient.invalidateQueries({ queryKey: ["repo-file-content", worktree] });
  }, [actions]);

  useRefetchOnMachineRecovery(machineOnline, () => {
    void queryClient.invalidateQueries({ queryKey: ["repo-files", worktree] });
    void queryClient.invalidateQueries({ queryKey: ["repo-file-content", worktree] });
  });

  // Same gap `use-git-panel.ts` has, same fix: the agent's own Write/Edit/
  // Bash tool calls never invalidate this query, so a newly created/changed
  // file stayed invisible until an unrelated refetch happened to occur.
  useRefetchOnTurnEnd(working, () => {
    void queryClient.invalidateQueries({ queryKey: ["repo-files", worktree] });
    void queryClient.invalidateQueries({ queryKey: ["repo-file-content", worktree] });
  });

  // `buildFileTree` is O(n*m) over the flat `git.files` list (a linear
  // `level.find` scan per path segment) and returns brand-new node objects
  // for every path. Calling it unmemoized in the render body rebuilt the
  // whole tree — and changed every node's identity — on every render of this
  // hook, defeating React reconciliation for the entire tree subtree.
  const tree = useMemo(
    () => (filesQuery.data ? buildFileTree(filesQuery.data) : []),
    [filesQuery.data],
  );

  return {
    tree,
    files: filesQuery.data,
    filesError: filesQuery.error instanceof Error ? filesQuery.error.message : null,
    isFilesLoading: filesQuery.isLoading,
    selectedPath,
    selectFile: setSelectedPath,
    // Once a first page has landed, `content` reflects the FULL accumulated
    // text across every loaded page — `truncated` mirrors `pagedContent`'s
    // own `canLoadMore`, so it naturally flips to `false` once the last page
    // stops reporting more content, and the "Load more" affordance
    // disappears with it. Falls back to the raw first-page result before
    // `pagedContent` has been seeded (a single render's worth of lag).
    content: pagedContent
      ? {
          inline: pagedContent.content,
          truncated: pagedContent.canLoadMore,
          blobRef: contentQuery.data?.blobRef,
        }
      : contentQuery.data,
    contentError: contentQuery.error instanceof Error ? contentQuery.error.message : null,
    isContentLoading: contentQuery.isLoading || contentQuery.isFetching,

    loadMoreContent: loadMoreMutation.mutate,
    isLoadingMoreContent: loadMoreMutation.isPending,
    loadMoreContentError:
      loadMoreMutation.error instanceof Error ? loadMoreMutation.error.message : null,
  };
}
