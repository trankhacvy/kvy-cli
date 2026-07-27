"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ChangedFilesList,
  CompareAgainstSelect,
  GitStatusError,
  GitToolbar,
  useGitPanel,
  useLiveGitDiffActions,
} from "@/features/git-diff";
import { ChecksPanel } from "@/features/github-checks";
import { FileTree, useLiveRepoFilesActions, useRepoFiles } from "@/features/repo-files";

type PanelTab = "changes" | "files" | "checks";

/**
 * A file/diff the user picked from this panel's Changes/All Files list —
 * lifted to `SessionTimelineScreen.tsx` (via `onOpenFile`) so it can swap
 * the main column's Timeline+Composer for a read-only viewer, conductor.build-
 * style (known-issues.md #7 follow-up). `path: null` (diff only) means "all
 * changed files" — `ChangedFilesList`'s own aggregate row.
 */
export interface OpenFile {
  kind: "content" | "diff";
  path: string | null;
  /** The Changes tab's current "Compare against" selection at the moment this diff was opened, so the main-column viewer matches what the sidebar showed — `null` = workspace default. Unused for `kind: "content"`. */
  compareRef: string | null;
}

const TABS: { id: PanelTab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "files", label: "All Files" },
  { id: "checks", label: "Checks" },
];

/**
 * Changes tab: branch/write-toolbar + "Compare against" + the changed-files
 * list — picking a row no longer renders a diff inline here (that made the
 * panel unusably cramped, a two-column layout built for a full page squeezed
 * into a narrow rail). It calls `onOpenFile` instead; the diff itself now
 * renders in the main column (`FileViewerColumn.tsx`).
 */
function ChangesTab({
  machineId,
  worktree,
  openPath,
  onOpenFile,
}: {
  machineId: string;
  worktree: string;
  openPath: string | null;
  onOpenFile: (file: OpenFile) => void;
}) {
  const actions = useLiveGitDiffActions(machineId);
  const panel = useGitPanel(actions, worktree);

  if (panel.isStatusLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading changed files…</p>;
  }

  if (panel.statusError || !panel.status) {
    return <GitStatusError panel={panel} />;
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <GitToolbar panel={panel} />
      <div className="flex items-center justify-end px-1">
        <CompareAgainstSelect
          compareRef={panel.compareRef}
          onChange={panel.setCompareRef}
          branches={panel.branches}
        />
      </div>
      <ChangedFilesList
        status={panel.status}
        selectedPath={openPath}
        onSelect={(path) => onOpenFile({ kind: "diff", path, compareRef: panel.compareRef })}
      />
    </div>
  );
}

/**
 * All Files tab: just the repo file tree now — picking a file calls
 * `onOpenFile` instead of rendering its content inline (see `ChangesTab`'s
 * own doc comment for why).
 */
function AllFilesTab({
  machineId,
  worktree,
  openPath,
  onOpenFile,
}: {
  machineId: string;
  worktree: string;
  openPath: string | null;
  onOpenFile: (file: OpenFile) => void;
}) {
  const actions = useLiveRepoFilesActions(machineId);
  const { tree, filesError, isFilesLoading } = useRepoFiles(actions, worktree);

  if (isFilesLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading repo files…</p>;
  }

  if (filesError) {
    return <p className="p-4 text-sm text-destructive">Could not load repo files: {filesError}</p>;
  }

  return (
    <div className="p-3">
      <FileTree
        tree={tree}
        selectedPath={openPath}
        onSelect={(path) => onOpenFile({ kind: "content", path, compareRef: null })}
      />
    </div>
  );
}

/**
 * The session screen's right-side workspace panel (known-issues.md #7):
 * Changes / All Files / Checks tabs. Changes/All Files are now pickers only
 * (`ChangesTab`/`AllFilesTab` above) — the actual diff/file content renders
 * in the main column via `FileViewerColumn.tsx`, driven by `openFile` state
 * `SessionTimelineScreen.tsx` owns (this panel just reports picks up via
 * `onOpenFile`, mirroring `openFile` back down only to highlight the active
 * row). Checks stays a normal inline tab — nothing to "open" there.
 */
export function SessionSidePanel({
  defaultTab = "changes",
  machineId,
  worktree,
  openFile,
  onOpenFile,
}: {
  defaultTab?: PanelTab;
  /** The session's owning machine (`SessionRow.machineId`). */
  machineId?: string;
  /** The session's workspace path (`SessionRow.workspaceId`). */
  worktree?: string;
  /** The file/diff currently open in the main column, or `null` — used only to highlight the active row in whichever list produced it. */
  openFile: OpenFile | null;
  onOpenFile: (file: OpenFile) => void;
}) {
  const [tab, setTab] = useState<PanelTab>(defaultTab);
  const ready = machineId !== undefined && worktree !== undefined;

  return (
    <aside className="hidden h-full w-[380px] shrink-0 flex-col border-l border-border lg:flex">
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as PanelTab)}
        className="flex h-full min-h-0 flex-col gap-0"
      >
        <div className="border-b border-border px-2 py-2">
          <TabsList variant="line">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!ready ? (
            <p className="p-4 text-sm text-muted-foreground">
              This session has no machine/workspace recorded yet.
            </p>
          ) : (
            <>
              <TabsContent value="changes" className="h-full">
                <ChangesTab
                  machineId={machineId}
                  worktree={worktree}
                  openPath={openFile?.kind === "diff" ? openFile.path : null}
                  onOpenFile={onOpenFile}
                />
              </TabsContent>
              <TabsContent value="files" className="h-full">
                <AllFilesTab
                  machineId={machineId}
                  worktree={worktree}
                  openPath={openFile?.kind === "content" ? openFile.path : null}
                  onOpenFile={onOpenFile}
                />
              </TabsContent>
              <TabsContent value="checks" className="h-full p-3">
                <ChecksPanel machineId={machineId} worktree={worktree} />
              </TabsContent>
            </>
          )}
        </div>
      </Tabs>
    </aside>
  );
}
