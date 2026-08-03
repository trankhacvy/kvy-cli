"use client";

import { DiffModeEnum } from "@git-diff-view/react";
import { useQuery } from "@tanstack/react-query";
import { Columns2, File as FileIcon, MessageSquare, Rows, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  buildDiffFetchOptions,
  UnifiedDiffViewer,
  useLiveGitDiffActions,
} from "@/features/git-diff";
import { FileViewer, useLiveRepoFilesActions } from "@/features/repo-files";
import { cn } from "@/lib/utils";
import type { OpenFile } from "./SessionSidePanel";

type ViewMode = "diff" | "content";

/** A small two-option segmented toggle (conductor.build-style Diff/Edit, Unified/Split) — plain buttons, not `Tabs`: two options in a header toolbar don't need `Tabs`' full keyboard-nav/ARIA-tablist machinery. `T` is `string | number` rather than just `string` so this also drives `DiffModeEnum` (a numeric enum), not only the `ViewMode` string union. */
function SegmentToggle<T extends string | number>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: React.ReactNode }[];
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium",
            value === option.value
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Replaces the main column's Timeline+Composer with a read-only file/diff
 * viewer (conductor.build-style) while
 * `openFile` is set — a single-tab "replace" model (Option A): opening a
 * new file swaps this one out rather than accumulating open tabs. The tab
 * strip's job is solely to get back — click "Timeline" (or the file tab's
 * own close button) to restore the normal chat view.
 *
 * A file with a real diff can toggle between "Diff" and "Edit" (conductor.
 * build's own naming) via `viewMode` — "Edit" is a display-mode label only,
 * not a write path: it renders through the same read-only `FileViewer` a
 * plain All Files click always has, there's no save/write RPC wired to it.
 * The diff view itself can independently toggle Unified/Split
 * (`diffMode`, `UnifiedDiffViewer`'s own `mode` prop) — `@git-diff-view/
 * react`'s `DiffView` already supports both natively.
 *
 * Independently calls `useLiveGitDiffActions`/`useLiveRepoFilesActions`
 * rather than sharing the sidebar's `ChangesTab`/`AllFilesTab` instances —
 * a second per-machine crypto worker while a file's open, traded for not
 * inventing new cross-component state-sharing plumbing that doesn't exist
 * anywhere else in this codebase yet (see those hooks' own doc comments:
 * each call site owns its worker). The actual `fs.read`/`git.diff` network
 * call still dedupes with whatever the sidebar already fetched — both
 * hooks' `useQuery` calls use the exact same query keys
 * (`use-repo-files.ts`/`use-git-panel.ts`), and TanStack Query's cache is
 * keyed on that array, not on which hook instance issued the call.
 */
export function FileViewerColumn({
  machineId,
  worktree,
  openFile,
  onBack,
}: {
  machineId: string;
  worktree: string;
  openFile: OpenFile;
  onBack: () => void;
}) {
  const repoFilesActions = useLiveRepoFilesActions(machineId);
  const gitDiffActions = useLiveGitDiffActions(machineId);

  // The "All changes" aggregate row (`openFile.path === null`) has no single
  // file to show content for — Diff is its only view, so the toggle itself
  // doesn't show. A real file opens in whichever view its own tab requested
  // (Changes → diff, All Files → content), but either view is always
  // available for it — `viewMode` is a local override on top of that
  // request, reset back to the requesting tab's default whenever a
  // DIFFERENT file opens (not on every re-render of the same one).
  const canToggleView = openFile.path !== null;
  const [viewMode, setViewMode] = useState<ViewMode>(
    openFile.kind === "content" ? "content" : "diff",
  );
  const [diffMode, setDiffMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately reset only by `openFile.path` (a new file opened) — `openFile.kind` re-running this on every parent re-render while the SAME file is open would stomp on an in-progress Diff/Edit toggle.
  useEffect(() => {
    setViewMode(openFile.kind === "content" ? "content" : "diff");
  }, [openFile.path]);

  const effectiveViewMode: ViewMode = canToggleView ? viewMode : "diff";

  const contentQuery = useQuery({
    queryKey: ["repo-file-content", worktree, openFile.path],
    queryFn: () => repoFilesActions.fetchFileContent(worktree, openFile.path as string),
    enabled: effectiveViewMode === "content" && openFile.path !== null,
  });

  const diffQuery = useQuery({
    queryKey: ["git-diff", worktree, openFile.path, openFile.compareRef],
    queryFn: () =>
      gitDiffActions.fetchDiff(worktree, buildDiffFetchOptions(openFile.path, openFile.compareRef)),
    enabled: effectiveViewMode === "diff",
  });

  const fileLabel = openFile.path
    ? (openFile.path.split("/").pop() ?? openFile.path)
    : "All changes";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/60"
        >
          <MessageSquare className="size-3.5" />
          Timeline
        </button>
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-md border-b-2 border-foreground bg-muted px-2 py-1.5 text-sm font-medium text-foreground",
          )}
        >
          <FileIcon className="size-3.5 shrink-0" />
          <span className="max-w-[16rem] truncate font-mono text-xs">{fileLabel}</span>
          <button
            type="button"
            onClick={onBack}
            aria-label="Close file"
            className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {effectiveViewMode === "diff" && (
            <SegmentToggle
              value={diffMode}
              onChange={setDiffMode}
              options={[
                { value: DiffModeEnum.Unified, label: <Rows className="size-3.5" /> },
                { value: DiffModeEnum.Split, label: <Columns2 className="size-3.5" /> },
              ]}
            />
          )}
          {canToggleView && (
            <SegmentToggle
              value={viewMode}
              onChange={setViewMode}
              options={[
                { value: "diff", label: "Diff" },
                { value: "content", label: "Edit" },
              ]}
            />
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {effectiveViewMode === "content" ? (
          contentQuery.isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading file…</p>
          ) : contentQuery.error ? (
            <p className="p-4 text-sm text-destructive">
              Could not load file: {(contentQuery.error as Error).message}
            </p>
          ) : contentQuery.data ? (
            <FileViewer path={openFile.path as string} content={contentQuery.data} />
          ) : null
        ) : diffQuery.isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading diff…</p>
        ) : diffQuery.error ? (
          <p className="p-4 text-sm text-destructive">
            Could not load diff: {(diffQuery.error as Error).message}
          </p>
        ) : diffQuery.data ? (
          <UnifiedDiffViewer diff={diffQuery.data} mode={diffMode} />
        ) : null}
      </div>
    </div>
  );
}
