"use client";

import type { PermissionMode } from "@falcon/wire";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  deriveAttention,
  deriveControlMode,
  deriveCurrentPermissionMode,
  getLastSeenAt,
  isTurnOpen,
  markSeenNow,
  SessionControlProvider,
  type UseSessionControl,
  useComposerState,
  useLiveRenderItems,
  useLiveSessionControl,
  useSessionEphemerals,
  useSessionModelChip,
  useSessionTitle,
  useTabAttention,
} from "@/features/session-control";
import { messagesQueryKey } from "@/sync";
import type { RenderItem } from "@/sync/reducer";
import { Composer } from "./Composer";
import { ControlBar } from "./ControlBar";
import { SessionHeaderActions } from "./SessionHeaderActions";
import { Timeline } from "./Timeline";
import { TimelineSkeleton } from "./TimelineSkeleton";

/**
 * Session timeline screen (falcon-system-design.md §9.2 "Session" row,
 * falcon-prd.md FR-7.2/FR-7.3/FR-7.4). Renders the reducer's `RenderItem[]`
 * output as a structured chat transcript plus the full control surface
 * (plan.md §16 "2.4 Web control surface"): `Composer` (queue-aware follow-up
 * input), `ControlBar` (interrupt/mode-selector/take-control), interactive
 * `PermCard`s inline in the transcript, live working/attention indicators,
 * and a tab title + favicon reflecting the max attention state.
 *
 * `items`/`useControl` both come from the real sync engine + session-scoped
 * crypto worker by default (`useLiveRenderItems`/`useLiveSessionControl`,
 * `features/session-control/use-session-crypto.ts`) — the hand-built
 * `demo-items.ts` fixture and `useMockSessionControl` this screen used to
 * default to are retired from this call site (still exported, for tests/
 * standalone review, from `features/session-control`). `useControl` stays
 * an injectable prop, mirroring `features/session-list`'s
 * `UseSessionListSnapshot` seam, so a test can still swap in
 * `useMockSessionControl` without touching `Composer`/`PermCard`/
 * `ControlBar`.
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

  // Viewing the screen counts as "seen" for this device (falcon-prd.md
  // FR-8.1's per-device last-seen timestamp) — marked once per session id,
  // not on every render, so a completed-turn-while-open doesn't immediately
  // re-flag "done" the instant it lands.
  useEffect(() => {
    markSeenNow(sessionId);
  }, [sessionId]);

  const { working: ephemeralWorking, attentionKind } = useSessionEphemerals(sessionId);
  const working = ephemeralWorking || isTurnOpen(items);
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
}) {
  const { mergedItems, send, sendAttachment, isSending, isQueued, cryptoReady, error, notice } =
    useComposerState(items);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate text-sm font-medium">
            {title ?? sessionId}
            {modelChip && (
              <Badge variant="secondary" className="font-normal">
                {modelChip}
              </Badge>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {working ? "Working…" : "Idle"} ·{" "}
            {controlMode === "local" ? "Local control" : "Remote control"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SessionHeaderActions sessionId={sessionId} />
          <Button asChild variant="outline" size="sm">
            <Link href={`/session/${sessionId}/git/`}>Files changed</Link>
          </Button>
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
      <ControlBar mode={permissionMode} controlMode={controlMode} working={working} />
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
      <Composer
        sessionId={sessionId}
        onSend={send}
        onAttach={sendAttachment}
        isSending={isSending}
        isQueued={isQueued}
        cryptoReady={cryptoReady}
        error={error}
        notice={notice}
      />
    </div>
  );
}
