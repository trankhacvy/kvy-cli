"use client";

import type { PermissionMode, SessionRow } from "@kvy/wire";
import { useQueryClient } from "@tanstack/react-query";
import { Globe, Play } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  deriveAttention,
  deriveControlMode,
  deriveCurrentPermissionMode,
  deriveWorking,
  getLastSeenAt,
  markSeenNow,
  SessionControlProvider,
  type UseSessionControl,
  useComposerState,
  useLiveRenderItems,
  useLiveSessionControl,
  useSessionControl,
  useSessionEphemerals,
  useSessionModelChip,
  useSessionTitle,
  useTabAttention,
} from "@/features/session-control";
import { useSessionWorkspacePath } from "@/features/session-list/use-session-workspace-path";
import { useLiveSlashCommandsActions, useSlashCommands } from "@/features/slash-commands";
import { copy } from "@/lib/copy";
import { useMachineOnline } from "@/lib/use-machine-online";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { cn } from "@/lib/utils";
import { messagesQueryKey } from "@/sync";
import type { RenderItem } from "@/sync/reducer";
import { Composer } from "./Composer";
import { ComposerControls } from "./ComposerControls";
import { FileViewerColumn } from "./FileViewerColumn";
import { MobileHandoffButton } from "./MobileHandoffDialog";
import { SessionActionsMenu } from "./SessionActionsMenu";
import { type OpenFile, SessionSidePanel } from "./SessionSidePanel";
import { Timeline } from "./Timeline";
import { TimelineSkeleton } from "./TimelineSkeleton";
import { WorkingDirectoryChip } from "./WorkingDirectoryChip";

/**
 * Session timeline screen. Renders the reducer's `RenderItem[]` as a chat transcript plus
 * control surface: `Composer`, interactive `PermCard`s, live working/attention indicators,
 * and a tab title reflecting max attention state.
 *
 * `useControl` is injectable so tests can swap in `useMockSessionControl` without touching
 * `Composer`/`PermCard`.
 */
export function SessionTimelineScreen({
  sessionId,
  useControl = useLiveSessionControl,
}: {
  sessionId: string;
  useControl?: UseSessionControl;
}) {
  const {
    items,
    error: decryptError,
    hasMore,
    isLoadingMore,
    isInitialLoading,
    loadEarlier,
  } = useLiveRenderItems(sessionId);
  const modelChip = useSessionModelChip(sessionId);
  const title = useSessionTitle(sessionId);
  const queryClient = useQueryClient();
  const retryDecrypt = () =>
    queryClient.invalidateQueries({ queryKey: messagesQueryKey(sessionId) });

  // Read straight off the `['sync']` snapshot rather than a second fetch. `undefined` until
  // the snapshot loads or the session isn't present; treated as `"active"` (never as
  // "ended"/"failed" by absence alone).
  const syncSnapshot = useSyncSnapshotQuery().data;
  const session = syncSnapshot?.sessions.find((s) => s.id === sessionId);
  // A reset-keys rotation (`/reset-keys/`) throws away the old key entirely — a session
  // whose own `keyEpoch` (mirrors `sessions.key_epoch`) is older than the account's current
  // one (`accountKeyEpoch`) can never be decrypted again, by design. Checked BEFORE trying
  // to render anything decrypt-dependent below, rather than letting `useLiveRenderItems`
  // fail and surfacing a raw decrypt error — see `LockedOldKeySessionScreen`.
  const isLockedOldKey =
    session?.keyEpoch !== undefined &&
    syncSnapshot?.accountKeyEpoch !== undefined &&
    session.keyEpoch < syncSnapshot.accountKeyEpoch;
  const sessionStatus: SessionRow["status"] = session?.status ?? "active";
  const provider = session?.provider ?? "";
  // `session.workspaceId` is an opaque `workspaces.id` now (never a real path
  // — the server must never see one). The real path is decrypted from
  // `session.metadata` instead, same as the session's title.
  const workspacePath = useSessionWorkspacePath(session);
  // The session's owning machine (`SessionRow.machineId`, same plaintext-on-
  // the-row convention as `workspacePath` above) — `null` until the row has
  // synced. Needed alongside `workspacePath` to fetch this session's custom
  // slash commands: `commands.list`
  // is a *machine*-scoped RPC (`m:<machineId>:commands.list`), so both ids
  // are required before it can even be attempted. Also threaded into
  // `SessionSidePanel`'s Checks tab so it
  // can gate its live `ChecksPanel` on both being present.
  const machineId = session?.machineId ?? null;
  // The composer's notice must never treat "we haven't heard from this
  // machine yet" as "offline" (`useMachineOnline`'s own "unknown must never
  // look like offline" rule) — so it uses `isKnownUnavailable`, not a plain
  // online/offline boolean.
  const machineAvailability = useMachineOnline(machineId);

  // Marked once per session id (not on every render) so a completed-turn-while-open
  // doesn't re-flag "done" the instant it lands.
  useEffect(() => {
    markSeenNow(sessionId);
  }, [sessionId]);

  // `deriveWorking` (`session-state.ts`) is authoritative on `isTurnOpen(items)`
  // — the always-fresh, persisted-envelope-derived signal — never masked by a
  // stuck `ephemeralWorking` (the header
  // must never show "Working…" once the transcript itself says the turn is
  // closed). `ephemeralWorking` only ever contributes before this session has
  // any turn history at all.
  const { working: ephemeralWorking, attentionKind } = useSessionEphemerals(sessionId);
  const working = deriveWorking(items, ephemeralWorking);
  // Recomputed every render rather than `useMemo`d: `items` is a small,
  // cheap-to-walk array (design principle #3: derived, never stored/cached
  // as a stale flag), and re-deriving on every render is correct regardless
  // of whether the caller's `items` reference is stable or a fresh array
  // each update (which `useLiveRenderItems` produces on every decrypt+reduce
  // pass, live-updated by the sync engine).
  const controlMode = deriveControlMode(items);
  const permissionMode = deriveCurrentPermissionMode(items);
  const attention = deriveAttention({
    items,
    ephemeralAttentionKind: attentionKind,
    lastSeenAt: getLastSeenAt(sessionId),
  });

  useTabAttention(title ?? `Session ${sessionId}`, attention, working);

  if (isLockedOldKey) {
    return <LockedOldKeySessionScreen sessionId={sessionId} />;
  }

  return (
    <SessionControlProvider
      sessionId={sessionId}
      useControl={useControl}
      machineOffline={machineAvailability.isKnownUnavailable}
      provider={provider}
    >
      <SessionTimelineBody
        sessionId={sessionId}
        title={title}
        items={items}
        controlMode={controlMode}
        permissionMode={permissionMode}
        working={working}
        decryptError={decryptError}
        onRetryDecrypt={retryDecrypt}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        isInitialLoading={isInitialLoading}
        onLoadEarlier={loadEarlier}
        modelChip={modelChip}
        sessionStatus={sessionStatus}
        workspacePath={workspacePath}
        machineId={machineId}
        provider={provider}
      />
    </SessionControlProvider>
  );
}

/** Split out so `useComposerState` (which needs `SessionControlProvider`
 * above it in the tree, via `useSessionControl()`) isn't called before the
 * provider mounts. */
function SessionTimelineBody({
  sessionId,
  title,
  items,
  controlMode,
  permissionMode,
  working,
  decryptError,
  onRetryDecrypt,
  hasMore,
  isLoadingMore,
  isInitialLoading,
  onLoadEarlier,
  modelChip,
  sessionStatus,
  workspacePath,
  machineId,
  provider,
}: {
  sessionId: string;
  /** Decrypted session title (`useSessionTitle`), or `null` until it's
   * resolved — falls back to the raw `sessionId`, same as the tab-title
   * override above. */
  title: string | null;
  items: RenderItem[];
  controlMode: "local" | "remote";
  permissionMode: PermissionMode;
  working: boolean;
  decryptError: string | null;
  onRetryDecrypt: () => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  /** `true` while this session's first message page + DEK unwrap are still
   * in flight (skeletons for the timeline's initial load). */
  isInitialLoading: boolean;
  onLoadEarlier: () => void;
  /** Decrypted `model` from this session's own metadata, or `null` until the
   * CLI records one there (the header's model chip). */
  modelChip: string | null;
  sessionStatus: SessionRow["status"];
  /** The session's registered workspace path (`SessionRow.workspaceId`), or
   * `null` until the row has synced/recorded one — the header's copy chip
   * is hidden entirely in that case. */
  workspacePath: string | null;
  /** The session's owning machine id (`SessionRow.machineId`), or `null`
   * until the row has synced — `commands.list` is a *machine*-scoped RPC,
   * so both this and
   * `workspacePath` gate the "/" autocomplete's fetch below. Also threaded
   * into `SessionSidePanel`'s Checks tab alongside `workspacePath`. */
  machineId: string | null;
  provider: string;
}) {
  const { mergedItems, send, sendAttachment, isSending, isQueued, cryptoReady, error, notice } =
    useComposerState(items);
  const { actions } = useSessionControl();
  // The file/diff currently open in place of Timeline+Composer (conductor.
  // build-style picker-in-sidebar/viewer-in-main-column split) — `null` shows the normal chat view.
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);

  const isDisabled = isSessionControlDisabled(sessionStatus);

  // "/" slash-command autocomplete:
  // `useLiveSlashCommandsActions` needs *a* machine id to call the hook
  // (rules of hooks), even before this session's row has synced one — it
  // degrades to a permanently-pending client until then, same as
  // `features/git-diff`'s own `machineId`-gated seam. The actual fetch stays
  // gated on both ids being present via `useSlashCommands`'s `worktree`
  // argument below.
  const slashCommandsActions = useLiveSlashCommandsActions(machineId ?? "");
  const slashCommands = useSlashCommands(
    slashCommandsActions,
    machineId && workspacePath ? workspacePath : null,
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl min-w-0 flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <p className="min-w-0 truncate text-base font-semibold">{title ?? sessionId}</p>
            {workspacePath && <WorkingDirectoryChip path={workspacePath} />}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="outline" size="icon-sm" aria-label="Preview">
                  <Link href={`/dashboard/session/${sessionId}/preview/`}>
                    <Globe className="size-3.5" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Preview</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="outline" size="icon-sm" aria-label="Setup / Run">
                  <Link href={`/dashboard/session/${sessionId}/run/`}>
                    <Play className="size-3.5" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Setup / Run</TooltipContent>
            </Tooltip>
            <MobileHandoffButton sessionId={sessionId} />
            <SessionActionsMenu
              sessionId={sessionId}
              title={title ?? sessionId}
              status={sessionStatus}
              machineId={machineId}
              workspacePath={workspacePath}
            />
          </div>
        </header>
        {openFile && machineId && workspacePath ? (
          <FileViewerColumn
            machineId={machineId}
            worktree={workspacePath}
            openFile={openFile}
            onBack={() => setOpenFile(null)}
          />
        ) : (
          <>
            {decryptError && (
              <div className="flex items-center justify-between gap-3 border-b border-border bg-destructive/10 px-4 py-2">
                <p className="text-sm text-destructive">{decryptError}</p>
                <Button type="button" variant="outline" size="sm" onClick={onRetryDecrypt}>
                  Retry
                </Button>
              </div>
            )}
            <LifecycleBanner sessionStatus={sessionStatus} />
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {isInitialLoading && items.length === 0 ? (
                <TimelineSkeleton />
              ) : (
                <Timeline
                  items={mergedItems}
                  working={working}
                  hasMore={hasMore}
                  isLoadingMore={isLoadingMore}
                  onLoadEarlier={onLoadEarlier}
                />
              )}
            </div>
            <div className="shrink-0 border-t border-border/70 bg-background">
              <Composer
                sessionId={sessionId}
                onSend={send}
                onAttach={sendAttachment}
                isSending={isSending}
                isQueued={isQueued}
                cryptoReady={cryptoReady}
                disabled={isDisabled}
                disabledPlaceholder={composerDisabledPlaceholder(sessionStatus)}
                error={error}
                notice={notice}
                working={working}
                onStop={() => actions.interrupt()}
                slashCommands={slashCommands}
                footerControls={
                  <ComposerControls
                    mode={permissionMode}
                    controlMode={controlMode}
                    disabled={isDisabled}
                    modelChip={modelChip}
                    provider={provider}
                  />
                }
              />
            </div>
          </>
        )}
      </div>
      <SessionSidePanel
        machineId={machineId ?? undefined}
        worktree={workspacePath ?? undefined}
        working={working}
        openFile={openFile}
        onOpenFile={setOpenFile}
        onSendAgentPrompt={send}
        isSendingAgentPrompt={isSending}
        actionsDisabled={isDisabled}
      />
    </div>
  );
}

/** Shown instead of the whole composer/timeline tree for a session whose `keyEpoch` is
 *  older than the account's current one (a reset-keys rotation threw away the only key
 *  that could ever decrypt it) — a plain, hook-free component with its own render test,
 *  same precedent as `isSessionControlDisabled`/`LifecycleBanner` below. Deliberately
 *  never attempts a decrypt (no `Timeline`/`Composer` mounted at all) rather than letting
 *  one fail and surfacing a raw "failed to decrypt" error the user can't act on. */
export function LockedOldKeySessionScreen({ sessionId }: { sessionId: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium">{copy.lockedSession.title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{copy.lockedSession.body}</p>
      <p className="mt-2 text-xs text-muted-foreground">{sessionId}</p>
    </div>
  );
}

/** Once the CLI process itself is gone (`ended`/`failed`) or the
 * session has been explicitly archived (its worktree already removed —
 * `ArchiveSessionDialog`), nothing sent from this screen can reach a live
 * process anymore — disable the controls rather than let a request
 * silently go nowhere. `compacted` (like `active`) describes an
 * in-progress turn on an otherwise still-controllable session, so it's the
 * only status left enabled.
 *
 * Exported (alongside `LifecycleBanner` below) as a plain, hook-free
 * function/component so the actual disabled-wiring rule and banner copy
 * have a direct render test (`SessionTimelineScreen.test.tsx`, via
 * `react-dom/server`'s `renderToStaticMarkup` — same no-jsdom style as
 * `lib/markdown.test.ts`) without needing to stand up this screen's full
 * live sync/crypto hook graph. */
export function isSessionControlDisabled(status: SessionRow["status"]): boolean {
  return status === "ended" || status === "failed" || status === "archived";
}

/** The read-only banner shown above the control bar once a session can no
 * longer be controlled from the web — ended, failed,
 * or archived. Renders nothing for every other status. */
export function LifecycleBanner({ sessionStatus }: { sessionStatus: SessionRow["status"] }) {
  if (!isSessionControlDisabled(sessionStatus)) return null;
  return (
    <div
      className={cn(
        "border-b border-border px-4 py-2 text-sm",
        sessionStatus === "failed"
          ? "bg-destructive/10 text-destructive"
          : "bg-muted/40 text-muted-foreground",
      )}
    >
      {lifecycleBannerCopy(sessionStatus)}
    </div>
  );
}

function lifecycleBannerCopy(sessionStatus: SessionRow["status"]): string {
  if (sessionStatus === "failed") {
    return "Session failed. This session can no longer be controlled from the web.";
  }
  if (sessionStatus === "archived") {
    return "This session is archived — read-only. You can view messages here, but the worktree has been removed and it can no longer be controlled from the web.";
  }
  return "Session ended. This session can no longer be controlled from the web.";
}

/** Composer's disabled-placeholder copy — archived gets its own, shorter
 * message (the full explanation already lives in `LifecycleBanner` above
 * it); ended/failed keep the original text. */
function composerDisabledPlaceholder(sessionStatus: SessionRow["status"]): string {
  return sessionStatus === "archived" ? "This session is archived." : "This session has ended.";
}
