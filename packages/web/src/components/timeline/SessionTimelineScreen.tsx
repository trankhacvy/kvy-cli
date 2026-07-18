"use client";

import type { SessionRow } from "@falcon/wire";
import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  deriveAttention,
  deriveControlMode,
  getLastSeenAt,
  isTurnOpen,
  markSeenNow,
  SessionControlProvider,
  type UseSessionControl,
  useComposerState,
  useLiveRenderItems,
  useLiveSessionControl,
  useSessionEphemerals,
  useTabAttention,
} from "@/features/session-control";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { cn } from "@/lib/utils";
import type { RenderItem } from "@/sync/reducer";
import { Composer } from "./Composer";
import { ControlBar } from "./ControlBar";
import { Timeline } from "./Timeline";

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
  const items = useLiveRenderItems(sessionId);

  // The session row's own lifecycle `status` (plan-v2.md W1.4+B15, design
  // §7.5's mode state machine) — read straight off the same `['sync']`
  // account snapshot `features/session-list/live-source.ts` already reads,
  // rather than threading a second fetch through this screen. `undefined`
  // until the snapshot has loaded or this session id isn't (yet) present in
  // it; treated the same as `"active"` below (the default a fresh session
  // row is created with) — never as "ended"/"failed" by absence alone.
  const sessionStatus: SessionRow["status"] =
    useSyncSnapshotQuery().data?.sessions.find((s) => s.id === sessionId)?.status ?? "active";

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
  const attention = deriveAttention({
    items,
    ephemeralAttentionKind: attentionKind,
    lastSeenAt: getLastSeenAt(sessionId),
  });

  useTabAttention(`Session ${sessionId}`, attention, working);

  return (
    <SessionControlProvider sessionId={sessionId} useControl={useControl}>
      <SessionTimelineBody
        sessionId={sessionId}
        items={items}
        controlMode={controlMode}
        working={working}
        sessionStatus={sessionStatus}
      />
    </SessionControlProvider>
  );
}

/** Split out so `useComposerState` (which needs `SessionControlProvider`
 * above it in the tree, via `useSessionControl()`) isn't called before the
 * provider mounts. */
function SessionTimelineBody({
  sessionId,
  items,
  controlMode,
  working,
  sessionStatus,
}: {
  sessionId: string;
  items: RenderItem[];
  controlMode: "local" | "remote";
  working: boolean;
  sessionStatus: SessionRow["status"];
}) {
  const { mergedItems, send, sendAttachment, isSending, isQueued, error, notice } =
    useComposerState(items);

  // Once the CLI process itself is gone (W1.4's `ended`/`failed` — as
  // opposed to `completed`/`archived`/`compacted`, which describe a turn or
  // an explicit archive on a session that's still otherwise controllable),
  // nothing sent from here can reach a live process anymore — disable the
  // controls rather than let a request silently go nowhere. Only these two
  // terminal states disable controls; `archived`/`compacted` (like
  // `active`) leave a still-controllable session's controls enabled.
  const isDisabled = sessionStatus === "ended" || sessionStatus === "failed";

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-medium">Session {sessionId}</p>
          <p className="text-xs text-muted-foreground">
            {working ? "Working…" : "Idle"} ·{" "}
            {controlMode === "local" ? "Local control" : "Remote control"}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/session/${sessionId}/git/`}>Files changed</Link>
        </Button>
      </header>
      {isDisabled && (
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
      )}
      <ControlBar
        mode="default"
        controlMode={controlMode}
        working={working}
        disabled={isDisabled}
      />
      <Timeline items={mergedItems} />
      <Composer
        onSend={send}
        onAttach={sendAttachment}
        isSending={isSending}
        isQueued={isQueued}
        disabled={isDisabled}
        error={error}
        notice={notice}
      />
    </div>
  );
}
