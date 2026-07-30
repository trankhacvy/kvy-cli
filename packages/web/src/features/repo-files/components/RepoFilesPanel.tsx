"use client";

import { MachineOfflineNotice } from "@/components/machine-offline-notice";
import { useMachineOnline } from "@/lib/use-machine-online";
import type { UseRepoFilesActions } from "../types";
import { useLiveRepoFilesActions } from "../use-live-repo-files-actions";
import { useRepoFiles } from "../use-repo-files";
import { FileTree } from "./FileTree";
import { FileViewer } from "./FileViewer";

/**
 * The Repo Files panel (docs/competitive-notes-omnara.md #5 "Full repo file
 * browser": "A 'Repo Files' sidebar tab browses and displays any file in
 * the repo ... not just files with diffs — a read-only code viewer with no
 * separate editor needed"): file tree on the left, the selected file's
 * syntax-highlighted, line-numbered content on the right. Read-only, same
 * MVP scope as `GitDiffPanel` — no save/edit actions here.
 *
 * `useActions` is the injectable seam — mirrors `GitDiffPanel`'s
 * `useActions` prop. Defaults to the real `useLiveRepoFilesActions`
 * (`(machineId) => machineRpcToRepoFilesActions(createMachineRpcClient({...}))`,
 * gated on the target machine's unwrapped DEK) — `mock-source.ts`'s
 * `useMockRepoFilesActions` stays exported for tests/standalone review,
 * same precedent as `GitDiffPanel`'s mock.
 */
export function RepoFilesPanel({
  machineId,
  worktree,
  useActions = useLiveRepoFilesActions,
}: {
  machineId: string;
  worktree: string;
  useActions?: UseRepoFilesActions;
}) {
  const actions = useActions(machineId);
  const machine = useMachineOnline(machineId);
  const {
    tree,
    filesError,
    isFilesLoading,
    selectedPath,
    selectFile,
    content,
    contentError,
    isContentLoading,
    loadMoreContent,
    isLoadingMoreContent,
  } = useRepoFiles(actions, worktree, !machine.isKnownUnavailable);

  if (isFilesLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading repo files…</p>;
  }

  if (filesError) {
    return <p className="p-4 text-sm text-destructive">Could not load repo files: {filesError}</p>;
  }

  return (
    <div className="grid h-full grid-cols-1 gap-4 md:grid-cols-[18rem_1fr]">
      <div className="md:col-span-2">
        <MachineOfflineNotice state={machine} />
      </div>
      <aside className="overflow-y-auto border-border md:border-r md:pr-3">
        <FileTree tree={tree} selectedPath={selectedPath} onSelect={selectFile} />
      </aside>
      <section className="min-w-0 overflow-y-auto">
        {selectedPath === null ? (
          <p className="p-4 text-sm text-muted-foreground">Select a file to view its contents.</p>
        ) : isContentLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading file…</p>
        ) : contentError ? (
          <p className="p-4 text-sm text-destructive">Could not load file: {contentError}</p>
        ) : content ? (
          <FileViewer
            path={selectedPath}
            content={content}
            onLoadMore={loadMoreContent}
            isLoadingMore={isLoadingMoreContent}
          />
        ) : null}
      </section>
    </div>
  );
}
