"use client";

import type { CheckRun } from "@kvy/wire";
import { EllipsisVertical, Eye } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { InlineCommandText } from "@/components/inline-command-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ChangedFilesList,
  CompareAgainstSelect,
  CreatePrButton,
  type GitPanelState,
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
import { type MachineOnlineState, useMachineOnline } from "@/lib/use-machine-online";

type PanelTab = "changes" | "files" | "checks";

/**
 * A file/diff the user picked from this panel's Changes/All Files list —
 * lifted to `SessionTimelineScreen.tsx` (via `onOpenFile`) so it can swap
 * the main column's Timeline+Composer for a read-only viewer, conductor.build-
 * style. `path: null` (diff only) means "all
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
 * The one write-adjacent action that stays visible outside the overflow
 * dialog (conductor.build-style: a single "Review" button next to the tab
 * bar, everything else tucked away) — spawns a sibling worktree session off
 * this one to review its changes. Only ever rendered once
 * `canUseWorkspaceActions` is true (the session is in a Kvy-managed
 * worktree and still controllable): a worktree off a worktree has nothing
 * to be a sibling of.
 */
function ReviewButton({
  machineId,
  worktree,
  codingBranch,
}: {
  machineId: string;
  worktree: string;
  codingBranch: string;
}) {
  const router = useRouter();
  const reviewSpawn = useReviewSpawn(machineId, (sessionId) => {
    saveDraft(sessionId, REVIEW_PROMPT);
    router.push(`/dashboard/session/${sessionId}/`);
  });
  const reviewSpawning = reviewSpawn.state.phase === "spawning";

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={reviewSpawning}
        onClick={() => reviewSpawn.start(worktree, codingBranch)}
      >
        <Eye className="size-3.5" />
        {reviewSpawning ? "Starting…" : "Review"}
      </Button>
      {reviewSpawn.state.phase === "error" && (
        <span className="text-xs text-destructive">{reviewSpawn.state.message}</span>
      )}
    </div>
  );
}

/**
 * The Create PR row — rendered
 * inside the Changes tab's overflow dialog (`GitActionsDialog` below), not
 * inline: Create PR still "works" at the repo root even outside a worktree,
 * but this row is only ever shown alongside worktree-only write actions, so
 * it shares their `canUseWorkspaceActions` gate for one consistent "is this
 * session steerable" story rather than two slightly different ones.
 */
function CreatePrRow({
  checks,
  onSendAgentPrompt,
  isSendingAgentPrompt,
}: {
  checks: ReturnType<typeof useChecksPanel>["checks"];
  onSendAgentPrompt: (text: string) => void;
  isSendingAgentPrompt: boolean;
}) {
  const compareUrl = manualCompareUrl(checks);

  return (
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
    </div>
  );
}

/**
 * Everything in the Changes tab that *mutates* the repo,
 * folded behind one overflow dialog so the tab itself
 * can just be a list (the old always-visible
 * commit/push toolbar + status checklist + Create PR row made the tab do
 * too many things at once — conductor.build's own Changes tab is just a
 * file list plus a Review button and this overflow). Commit/push/branch-
 * rename/remote (`GitToolbar`) always show; the PR checklist row/Create PR
 * row/"Compare against" only show once `canUseWorkspaceActions` (same gate
 * `ChangesTab` already applies to the same content today).
 */
function GitActionsDialog({
  open,
  onOpenChange,
  machine,
  panel,
  checks,
  canUseWorkspaceActions,
  onSendAgentPrompt,
  isSendingAgentPrompt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machine: MachineOnlineState;
  panel: GitPanelState;
  checks: ReturnType<typeof useChecksPanel>["checks"];
  canUseWorkspaceActions: boolean;
  onSendAgentPrompt: (text: string) => void;
  isSendingAgentPrompt: boolean;
}) {
  if (!panel.status) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Git actions</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <GitToolbar panel={panel} machineUnavailable={machine.isKnownUnavailable} />
          {canUseWorkspaceActions && (
            <div className="flex flex-col gap-2">
              <GitStatusChecklist
                uncommittedCount={panel.status.files.length}
                checks={checks}
                onCommitAndPush={() =>
                  document.getElementById("git-toolbar-commit-message")?.focus()
                }
                onCreatePr={() => onSendAgentPrompt(CREATE_PR_PROMPT)}
              />
              <CreatePrRow
                checks={checks}
                onSendAgentPrompt={onSendAgentPrompt}
                isSendingAgentPrompt={isSendingAgentPrompt}
              />
            </div>
          )}
          <CompareAgainstSelect
            compareRef={panel.compareRef}
            onChange={panel.setCompareRef}
            branches={panel.branches}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Changes tab (conductor.build-style): just the changed-files list, plus a
 * header with the file count, a Review button, and one overflow icon for
 * everything that mutates the repo (`GitActionsDialog` — commit/push/
 * branch-rename/remote, the PR status checklist, Create PR, "Compare
 * against"). Previously all of that lived always-visible above the list,
 * which made the tab do too many things at once for a 380px rail — picking
 * a file row itself has already been decoupled from rendering a diff inline
 * here (it calls `onOpenFile`; the diff renders in the main column,
 * `FileViewerColumn.tsx`) for the same "this rail is for picking, not
 * doing" reason.
 *
 * `machine`/`panel` are lifted from `SessionSidePanel` (which already gates
 * this tab's very existence on the workspace being reachable and healthy) —
 * this component no longer needs its own loading/error branches for them.
 * `checks` stays a local `useChecksPanel` call — unrelated to that gate, and
 * Radix `TabsContent` unmounts an inactive tab by default, so this and the
 * Checks tab's own `ChecksPanel` are never both mounted at once.
 */
function ChangesTab({
  machineId,
  worktree,
  machine,
  panel,
  openPath,
  onOpenFile,
  onSendAgentPrompt,
  isSendingAgentPrompt,
  actionsDisabled,
}: {
  machineId: string;
  worktree: string;
  machine: MachineOnlineState;
  panel: GitPanelState;
  openPath: string | null;
  onOpenFile: (file: OpenFile) => void;
  onSendAgentPrompt: (text: string) => void;
  isSendingAgentPrompt: boolean;
  actionsDisabled: boolean;
}) {
  const checksActions = useLiveGithubChecksActions(machineId);
  const { checks } = useChecksPanel(checksActions, worktree, !machine.isKnownUnavailable);
  const [actionsOpen, setActionsOpen] = useState(false);

  if (!panel.status) return null;

  const canUseWorkspaceActions = looksLikeWorktreePath(worktree) && !actionsDisabled;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-sm">
          <span className="font-medium">{panel.status.branch}</span>
          <span className="text-muted-foreground"> · {panel.status.files.length} changed</span>
        </span>
        <div className="flex items-center gap-1">
          {canUseWorkspaceActions && (
            <ReviewButton
              machineId={machineId}
              worktree={worktree}
              codingBranch={panel.status.branch}
            />
          )}
          <Button
            size="icon"
            variant="ghost"
            aria-label="Git actions"
            onClick={() => setActionsOpen(true)}
          >
            <EllipsisVertical className="size-4" />
          </Button>
        </div>
      </div>
      <ChangedFilesList
        status={panel.status}
        selectedPath={openPath}
        onSelect={(path) => onOpenFile({ kind: "diff", path, compareRef: panel.compareRef })}
      />
      <GitActionsDialog
        open={actionsOpen}
        onOpenChange={setActionsOpen}
        machine={machine}
        panel={panel}
        checks={checks}
        canUseWorkspaceActions={canUseWorkspaceActions}
        onSendAgentPrompt={onSendAgentPrompt}
        isSendingAgentPrompt={isSendingAgentPrompt}
      />
    </div>
  );
}

/**
 * All Files tab: just the repo file tree now — picking a file calls
 * `onOpenFile` instead of rendering its content inline (see `ChangesTab`'s
 * own doc comment for why). `machine` is lifted from `SessionSidePanel`,
 * which already gates this tab's existence on the machine being reachable —
 * no need for its own `MachineOfflineNotice` render here.
 */
function AllFilesTab({
  machineId,
  worktree,
  machine,
  working,
  openPath,
  onOpenFile,
}: {
  machineId: string;
  worktree: string;
  machine: MachineOnlineState;
  working: boolean;
  openPath: string | null;
  onOpenFile: (file: OpenFile) => void;
}) {
  const actions = useLiveRepoFilesActions(machineId);
  const { tree, filesError, isFilesLoading } = useRepoFiles(
    actions,
    worktree,
    !machine.isKnownUnavailable,
    working,
  );

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
 * The session screen's right-side workspace panel:
 * Changes / All Files / Checks tabs, plus the Create PR / Review / Fix CI
 * workflow actions. Changes/All Files are
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
 * worktree-eligible session that's ended or offline must still hide these actions.
 */
export function SessionSidePanel({
  defaultTab = "changes",
  machineId,
  worktree,
  working,
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
  /** `deriveWorking(items, ephemeralWorking)` (`SessionTimelineScreen.tsx`) — the agent's own file-writing tool calls never invalidate the Changes/All Files queries themselves (no push channel of their own, `use-git-panel.ts`'s doc comment), so this panel refetches both on the true -> false ("turn just ended") edge instead (`use-refetch-on-turn-end.ts`). Defaults to `false` for callers that don't track it (no refetch-on-turn-end, today's behavior). */
  working?: boolean;
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

  // Hoisted above the three tabs (rather than each tab independently
  // fetching `git.status` and rendering its own error copy), checked in the
  // order each fact becomes knowable. `machineUnavailable` comes first: the
  // workspace query itself is disabled while the machine is unreachable (see
  // `useGitPanel`'s `enabled` arg below), so we genuinely don't know yet
  // whether the workspace is fine, missing, or not-a-repo — showing tabs (or
  // a workspace-specific message) would be guessing. It also matches
  // `useChecksPanel`'s own query, which has no `enabled` gate at all and
  // would otherwise fire a doomed RPC and eat the ~17s reconnect-grace
  // timeout (`use-machine-online.ts`'s docblock) every time this renders.
  // Once the machine answers, `workspaceGone` (folder missing, or any other
  // unclassified git failure) has literally nothing any of the three tabs
  // could show — All Files' own fs fallback can't list a folder that doesn't
  // exist either — so it replaces the WHOLE tab bar with one message.
  // `notARepo` (folder exists, just never `git init`ed) is different: All
  // Files still works fine there (`gitFiles.ts`'s plain-fs-walk fallback), so
  // only Changes/Checks — which genuinely need git — swap their content for
  // the same "set up git here" message; the tab bar and All Files stay live.
  const machine = useMachineOnline(machineId);
  const machineUnavailable = ready && machine.isKnownUnavailable;
  const gitActions = useLiveGitDiffActions(machineId ?? "");
  const panel = useGitPanel(gitActions, worktree ?? "", ready && !machineUnavailable, working);
  const workspaceLoading = ready && !machineUnavailable && panel.isStatusLoading;
  const notARepo = ready && !machineUnavailable && panel.statusErrorCode === "workspace-not-a-repo";
  const workspaceGone =
    ready &&
    !machineUnavailable &&
    !workspaceLoading &&
    !notARepo &&
    (Boolean(panel.statusError) || !panel.status);

  return (
    <aside className="hidden h-full w-[380px] shrink-0 flex-col border-l border-border lg:flex">
      {!ready ? (
        <p className="p-4 text-sm text-muted-foreground">
          This session has no machine/workspace recorded yet.
        </p>
      ) : machineUnavailable && machine.reason !== null ? (
        <p className="p-4 text-sm text-muted-foreground">
          <InlineCommandText text={machine.reason} />
        </p>
      ) : workspaceGone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <GitStatusError panel={panel} />
        </div>
      ) : (
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
            <TabsContent value="changes" className="h-full">
              {workspaceLoading ? (
                <p className="p-4 text-sm text-muted-foreground">Loading changed files…</p>
              ) : notARepo ? (
                <GitStatusError panel={panel} />
              ) : (
                <ChangesTab
                  machineId={machineId}
                  worktree={worktree}
                  machine={machine}
                  panel={panel}
                  openPath={openFile?.kind === "diff" ? openFile.path : null}
                  onOpenFile={onOpenFile}
                  onSendAgentPrompt={onSendAgentPrompt}
                  isSendingAgentPrompt={isSendingAgentPrompt}
                  actionsDisabled={actionsDisabled}
                />
              )}
            </TabsContent>
            <TabsContent value="files" className="h-full">
              <AllFilesTab
                machineId={machineId}
                worktree={worktree}
                machine={machine}
                working={working ?? false}
                openPath={openFile?.kind === "content" ? openFile.path : null}
                onOpenFile={onOpenFile}
              />
            </TabsContent>
            <TabsContent value="checks" className="h-full p-3">
              {workspaceLoading ? (
                <p className="p-4 text-sm text-muted-foreground">Loading checks…</p>
              ) : notARepo ? (
                <GitStatusError panel={panel} />
              ) : (
                <ChecksPanel
                  machineId={machineId}
                  worktree={worktree}
                  onFixWithAgent={
                    looksLikeWorktreePath(worktree) && !actionsDisabled
                      ? (check: CheckRun) => onSendAgentPrompt(buildFixCiPrompt(check))
                      : undefined
                  }
                />
              )}
            </TabsContent>
          </div>
        </Tabs>
      )}
    </aside>
  );
}
