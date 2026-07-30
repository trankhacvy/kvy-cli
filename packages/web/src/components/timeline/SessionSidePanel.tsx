"use client";

import type { CheckRun } from "@falcon/wire";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MachineOfflineNotice } from "@/components/machine-offline-notice";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ChangedFilesList,
  CompareAgainstSelect,
  CreatePrButton,
  GitStatusChecklist,
  GitStatusError,
  GitToolbar,
  manualCompareUrl,
  useGitPanel,
  useLiveGitDiffActions,
} from "@/features/git-diff";
import { ChecksPanel, useChecksPanel, useLiveGithubChecksActions } from "@/features/github-checks";
import { FileTree, useLiveRepoFilesActions, useRepoFiles } from "@/features/repo-files";
import { saveDraft } from "@/features/session-control";
import { looksLikeWorktreePath, useReviewSpawn } from "@/features/session-list";
import { buildFixCiPrompt, CREATE_PR_PROMPT, REVIEW_PROMPT } from "@/lib/agent-prompts";
import { useMachineOnline } from "@/lib/use-machine-online";

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
 * The Create PR / Review action row (session-panel-workflow-plan.md Phases
 * 2-3) — only ever rendered once `canUseWorkspaceActions` is true (the
 * session is in a Falcon-managed worktree and still controllable): every
 * action here is either unsafe or meaningless outside a worktree (Create PR
 * still "works" at the repo root, but Review — a sibling worktree off the
 * SAME repo root — has nothing to be a sibling of).
 */
function WorkspaceActionsRow({
  machineId,
  worktree,
  codingBranch,
  checks,
  onSendAgentPrompt,
  isSendingAgentPrompt,
}: {
  machineId: string;
  worktree: string;
  codingBranch: string;
  checks: ReturnType<typeof useChecksPanel>["checks"];
  onSendAgentPrompt: (text: string) => void;
  isSendingAgentPrompt: boolean;
}) {
  const router = useRouter();
  const reviewSpawn = useReviewSpawn(machineId, (sessionId) => {
    saveDraft(sessionId, REVIEW_PROMPT);
    router.push(`/dashboard/session/${sessionId}/`);
  });
  const compareUrl = manualCompareUrl(checks);
  const reviewSpawning = reviewSpawn.state.phase === "spawning";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {compareUrl && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.open(compareUrl, "_blank", "noopener,noreferrer")}
          >
            Open PR on GitHub
          </Button>
        )}
        <CreatePrButton onSend={onSendAgentPrompt} disabled={isSendingAgentPrompt} />
        <Button
          size="sm"
          variant="outline"
          disabled={reviewSpawning}
          onClick={() => reviewSpawn.start(worktree, codingBranch)}
        >
          {reviewSpawning ? "Starting review…" : "Review"}
        </Button>
      </div>
      {reviewSpawn.state.phase === "error" && (
        <span className="text-xs text-destructive">{reviewSpawn.state.message}</span>
      )}
    </div>
  );
}

/**
 * Changes tab: branch/write-toolbar + status checklist + Create PR/Review
 * actions + "Compare against" + the changed-files list — picking a row no
 * longer renders a diff inline here (that made the panel unusably cramped,
 * a two-column layout built for a full page squeezed into a narrow rail).
 * It calls `onOpenFile` instead; the diff itself now renders in the main
 * column (`FileViewerColumn.tsx`).
 *
 * Mounts its own `useChecksPanel` (rather than sharing one lifted from
 * `SessionSidePanel`) — Radix `TabsContent` unmounts an inactive tab by
 * default, so this and the Checks tab's own `ChecksPanel` are never both
 * mounted at once; there's no concurrent-poll cost to avoid.
 */
function ChangesTab({
  machineId,
  worktree,
  openPath,
  onOpenFile,
  onSendAgentPrompt,
  isSendingAgentPrompt,
  actionsDisabled,
}: {
  machineId: string;
  worktree: string;
  openPath: string | null;
  onOpenFile: (file: OpenFile) => void;
  onSendAgentPrompt: (text: string) => void;
  isSendingAgentPrompt: boolean;
  actionsDisabled: boolean;
}) {
  const machine = useMachineOnline(machineId);
  const actions = useLiveGitDiffActions(machineId);
  const panel = useGitPanel(actions, worktree, !machine.isKnownUnavailable);
  const checksActions = useLiveGithubChecksActions(machineId);
  const { checks } = useChecksPanel(checksActions, worktree, !machine.isKnownUnavailable);

  if (panel.isStatusLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading changed files…</p>;
  }

  if (panel.statusError || !panel.status) {
    return (
      <>
        <MachineOfflineNotice state={machine} />
        <GitStatusError panel={panel} />
      </>
    );
  }

  const canUseWorkspaceActions = looksLikeWorktreePath(worktree) && !actionsDisabled;

  return (
    <div className="flex flex-col gap-3 p-3">
      <MachineOfflineNotice state={machine} />
      <GitToolbar panel={panel} machineUnavailable={machine.isKnownUnavailable} />
      {canUseWorkspaceActions && (
        <div className="flex flex-col gap-2 px-1">
          <GitStatusChecklist
            uncommittedCount={panel.status.files.length}
            checks={checks}
            onCommitAndPush={() => document.getElementById("git-toolbar-commit-message")?.focus()}
            onCreatePr={() => onSendAgentPrompt(CREATE_PR_PROMPT)}
          />
          <WorkspaceActionsRow
            machineId={machineId}
            worktree={worktree}
            codingBranch={panel.status.branch}
            checks={checks}
            onSendAgentPrompt={onSendAgentPrompt}
            isSendingAgentPrompt={isSendingAgentPrompt}
          />
        </div>
      )}
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
  const machine = useMachineOnline(machineId);
  const actions = useLiveRepoFilesActions(machineId);
  const { tree, filesError, isFilesLoading } = useRepoFiles(
    actions,
    worktree,
    !machine.isKnownUnavailable,
  );

  if (isFilesLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading repo files…</p>;
  }

  if (filesError) {
    return <p className="p-4 text-sm text-destructive">Could not load repo files: {filesError}</p>;
  }

  return (
    <div className="p-3">
      <MachineOfflineNotice state={machine} />
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
 * Changes / All Files / Checks tabs, plus the Create PR / Review / Fix CI
 * workflow actions (session-panel-workflow-plan.md). Changes/All Files are
 * pickers only (`ChangesTab`/`AllFilesTab` above) — the actual diff/file
 * content renders in the main column via `FileViewerColumn.tsx`, driven by
 * `openFile` state `SessionTimelineScreen.tsx` owns (this panel just
 * reports picks up via `onOpenFile`, mirroring `openFile` back down only to
 * highlight the active row). Checks stays a normal inline tab — nothing to
 * "open" there, but its check-run rows can now trigger `onSendAgentPrompt`
 * via `onFixWithAgent`.
 *
 * `onSendAgentPrompt`/`isSendingAgentPrompt` are `useComposerState`'s
 * `send`/`isSending`, lifted from the one `useComposerState(items)` call
 * `SessionTimelineBody` already makes — every "inject a prompt" action in
 * this panel routes through it rather than a raw `sendMessage()` call, so
 * it shares the composer's own optimistic-pending/error handling.
 * `actionsDisabled` is `isSessionControlDisabled(sessionStatus)` — combined
 * with `looksLikeWorktreePath(worktree)` at each action's own gate, since a
 * worktree-eligible session that's ended, or offline, must still hide these
 * actions (session-panel-workflow-plan.md §2).
 */
export function SessionSidePanel({
  defaultTab = "changes",
  machineId,
  worktree,
  openFile,
  onOpenFile,
  onSendAgentPrompt,
  isSendingAgentPrompt,
  actionsDisabled,
}: {
  defaultTab?: PanelTab;
  /** The session's owning machine (`SessionRow.machineId`). */
  machineId?: string;
  /** The session's workspace path (`SessionRow.workspaceId`). */
  worktree?: string;
  /** The file/diff currently open in the main column, or `null` — used only to highlight the active row in whichever list produced it. */
  openFile: OpenFile | null;
  onOpenFile: (file: OpenFile) => void;
  /** `ComposerState.send` — every synthetic Create PR/Review/Fix CI prompt goes through this, never a raw `sendMessage()` call. */
  onSendAgentPrompt: (text: string) => void;
  isSendingAgentPrompt: boolean;
  /** `isSessionControlDisabled(sessionStatus)` — an ended/failed session can't be steered from here regardless of worktree eligibility. */
  actionsDisabled: boolean;
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
                  onSendAgentPrompt={onSendAgentPrompt}
                  isSendingAgentPrompt={isSendingAgentPrompt}
                  actionsDisabled={actionsDisabled}
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
                <ChecksPanel
                  machineId={machineId}
                  worktree={worktree}
                  onFixWithAgent={
                    looksLikeWorktreePath(worktree) && !actionsDisabled
                      ? (check: CheckRun) => onSendAgentPrompt(buildFixCiPrompt(check))
                      : undefined
                  }
                />
              </TabsContent>
            </>
          )}
        </div>
      </Tabs>
    </aside>
  );
}
