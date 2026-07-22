"use client";

import type { PermissionMode, SessionRow } from "@falcon/wire";
import { useQueryClient } from "@tanstack/react-query";
import { FolderGit2, Globe } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { useLiveSlashCommandsActions, useSlashCommands } from "@/features/slash-commands";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { cn } from "@/lib/utils";
import { messagesQueryKey } from "@/sync";
import type { RenderItem } from "@/sync/reducer";
import { Composer } from "./Composer";
import { ComposerControls } from "./ComposerControls";
import { SessionActionsMenu } from "./SessionActionsMenu";
import { SessionSidePanel } from "./SessionSidePanel";
import { Timeline } from "./Timeline";
import { TimelineSkeleton } from "./TimelineSkeleton";
import { WorkingDirectoryChip } from "./WorkingDirectoryChip";

/**
 * Session timeline screen (falcon-system-design.md §9.2 "Session" row,
 * falcon-prd.md FR-7.2/FR-7.3/FR-7.4). Renders the reducer's `RenderItem[]`
 * output as a structured chat transcript plus the full control surface
 * (plan.md §16 "2.4 Web control surface"): `Composer` (queue-aware follow-up
 * input + footer session chips), interactive `PermCard`s inline in the
 * transcript, live working/attention indicators, and a tab title + favicon
 * reflecting the max attention state.
 *
 * `items`/`useControl` both come from the real sync engine + session-scoped
 * crypto worker by default (`useLiveRenderItems`/`useLiveSessionControl`,
 * `features/session-control/use-session-crypto.ts`). `useControl` stays an
 * injectable prop, mirroring `features/session-list`'s
 * `UseSessionListSnapshot` seam, so a test can still swap in
 * `useMockSessionControl` without touching `Composer`/`PermCard`.
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

  // The session row's own lifecycle `status` (plan-v2.md W1.4+B15, design
  // §7.5's mode state machine) — read straight off the same `['sync']`
  // account snapshot `features/session-list/live-source.ts` already reads,
  // rather than threading a second fetch through this screen. `undefined`
  // until the snapshot has loaded or this session id isn't (yet) present in
  // it; treated the same as `"active"` below (the default a fresh session
  // row is created with) — never as "ended"/"failed" by absence alone.
  const session = useSyncSnapshotQuery().data?.sessions.find((s) => s.id === sessionId);
  const sessionStatus: SessionRow["status"] = session?.status ?? "active";
  // `workspaceId` (when set) *is* the workspace's real absolute directory
  // path — same plaintext-on-the-row convention `SessionGitScreen` already
  // relies on (design §5.3: the server is allowed to see this field, unlike
  // `metadata`'s encrypted title, so no decrypt is needed here either).
  const workspacePath = session?.workspaceId ?? null;
  // The session's owning machine (`SessionRow.machineId`, same plaintext-on-
  // the-row convention as `workspacePath` above) — `null` until the row has
  // synced. Needed alongside `workspacePath` to fetch this session's custom
  // slash commands (docs/competitive-notes-omnara.md #18): `commands.list`
  // is a *machine*-scoped RPC (`m:<machineId>:commands.list`), so both ids
  // are required before it can even be attempted.
  const machineId = session?.machineId ?? null;

  // Viewing the screen counts as "seen" for this device (falcon-prd.md
  // FR-8.1's per-device last-seen timestamp) — marked once per session id,
  // not on every render, so a completed-turn-while-open doesn't immediately
  // re-flag "done" the instant it lands.
  useEffect(() => {
    markSeenNow(sessionId);
  }, [sessionId]);

  // `deriveWorking` (`session-state.ts`) is authoritative on `isTurnOpen(items)`
  // — the always-fresh, persisted-envelope-derived signal — never masked by a
  // stuck `ephemeralWorking` (docs/user-flows.md fix-plan item 2: the header
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

  return (
    <SessionControlProvider sessionId={sessionId} useControl={useControl}>
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
   * in flight (plan-v2.md W4.2 "skeletons for … timeline initial loads"). */
  isInitialLoading: boolean;
  onLoadEarlier: () => void;
  /** Decrypted `model` from this session's own metadata, or `null` until the
   * CLI records one there (plan-v2.md W4.2 "header model chip"). */
  modelChip: string | null;
  sessionStatus: SessionRow["status"];
  /** The session's registered workspace path (`SessionRow.workspaceId`), or
   * `null` until the row has synced/recorded one — the header's copy chip
   * (docs/competitive-notes-omnara.md #21) is hidden entirely in that case. */
  workspacePath: string | null;
  /** The session's owning machine id (`SessionRow.machineId`), or `null`
   * until the row has synced — `commands.list` (docs/competitive-notes-
   * omnara.md #18) is a *machine*-scoped RPC, so both this and
   * `workspacePath` gate the "/" autocomplete's fetch below. */
  machineId: string | null;
}) {
  const { mergedItems, send, sendAttachment, isSending, isQueued, cryptoReady, error, notice } =
    useComposerState(items);
  const { actions } = useSessionControl();
  const [panelOpen, setPanelOpen] = useState(true);

  const isDisabled = isSessionControlDisabled(sessionStatus);

  // "/" slash-command autocomplete (docs/competitive-notes-omnara.md #18):
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
            <Button asChild variant="outline" size="sm">
              <Link href={`/session/${sessionId}/git/`}>Files changed</Link>
            </Button>
            <Button
              type="button"
              variant={panelOpen ? "secondary" : "outline"}
              size="sm"
              onClick={() => setPanelOpen((open) => !open)}
              aria-pressed={panelOpen}
            >
              <FolderGit2 className="size-3.5" />
              Repo root
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled
              title="Preview isn't available yet"
            >
              <Globe className="size-3.5" />
              Preview
            </Button>
            <SessionActionsMenu sessionId={sessionId} disabled={isDisabled} />
          </div>
        </header>
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
              />
            }
          />
        </div>
      </div>
      {panelOpen && <SessionSidePanel />}
    </div>
  );
}

/** Once the CLI process itself is gone (W1.4's `ended`/`failed` — as
 * opposed to `completed`/`archived`/`compacted`, which describe a turn or
 * an explicit archive on a session that's still otherwise controllable),
 * nothing sent from this screen can reach a live process anymore — disable
 * the controls rather than let a request silently go nowhere. Only these
 * two terminal states disable controls; `archived`/`compacted` (like
 * `active`) leave a still-controllable session's controls enabled.
 *
 * Exported (alongside `LifecycleBanner` below) as a plain, hook-free
 * function/component so the actual disabled-wiring rule and banner copy
 * have a direct render test (`SessionTimelineScreen.test.tsx`, via
 * `react-dom/server`'s `renderToStaticMarkup` — same no-jsdom style as
 * `lib/markdown.test.ts`) without needing to stand up this screen's full
 * live sync/crypto hook graph. */
export function isSessionControlDisabled(status: SessionRow["status"]): boolean {
  return status === "ended" || status === "failed";
}

/** The ended/failed banner shown above the control bar (plan-v2.md
 * W1.4+B15). Renders nothing for every other status. */
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
      {sessionStatus === "failed"
        ? "Session failed — this session can no longer be controlled from the web."
        : "Session ended — this session can no longer be controlled from the web."}
    </div>
  );
}
