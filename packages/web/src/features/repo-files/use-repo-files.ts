"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { buildFileTree } from "./file-tree-logic";
import type { RepoFilesActions } from "./types";

/**
 * The Repo Files panel's data-fetching state (docs/competitive-notes-
 * omnara.md #5): `git.files` once per `worktree` to build the tree, then
 * `fs.read` re-fetched whenever the selected file changes. Mirrors
 * `features/git-diff/use-git-panel.ts`'s shape exactly — plain `useQuery`
 * (not the sync engine's invalidate-on-update machinery), a point-in-time
 * RPC snapshot the user refreshes by re-selecting or explicit re-fetch.
 */
export function useRepoFiles(actions: RepoFilesActions, worktree: string) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const filesQuery = useQuery({
    queryKey: ["repo-files", worktree],
    queryFn: () => actions.fetchFileList(worktree),
  });

  const contentQuery = useQuery({
    queryKey: ["repo-file-content", worktree, selectedPath],
    queryFn: () => actions.fetchFileContent(worktree, selectedPath as string),
    // Nothing to fetch until a file is actually selected — mirrors
    // `use-git-panel.ts`'s "avoid a race with the file list" enabled guard.
    enabled: selectedPath !== null,
  });

  const tree = filesQuery.data ? buildFileTree(filesQuery.data) : [];

  return {
    tree,
    files: filesQuery.data,
    filesError: filesQuery.error instanceof Error ? filesQuery.error.message : null,
    isFilesLoading: filesQuery.isLoading,
    selectedPath,
    selectFile: setSelectedPath,
    content: contentQuery.data,
    contentError: contentQuery.error instanceof Error ? contentQuery.error.message : null,
    isContentLoading: contentQuery.isLoading || contentQuery.isFetching,
  };
}
