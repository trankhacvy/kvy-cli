"use client";

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
  useMockSessionControl,
  useSessionEphemerals,
  useTabAttention,
} from "@/features/session-control";
import type { RenderItem } from "@/sync/reducer";
import { Composer } from "./Composer";
import { ControlBar } from "./ControlBar";
import { demoRenderItems } from "./demo-items";
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
 * `useControl` is the injectable seam for the session RPC actions — mirrors
 * `features/session-list`'s `UseSessionListSnapshot`: `apiSocket` and a
 * per-session crypto client (to unwrap the session's DEK) aren't wired into
 * this screen yet (it still runs off `demo-items.ts`, a separate in-flight
 * task), so this defaults to `useMockSessionControl`. Swapping in
 * `(id) => sessionRpcToActions(createSessionRpcClient({...}))` once that
 * data layer lands is a one-line change here — no other change needed
 * anywhere in `Composer`/`PermCard`/`ControlBar`.
 */
export function SessionTimelineScreen({
  sessionId,
  useControl = useMockSessionControl,
}: {
  sessionId: string;
  useControl?: UseSessionControl;
}) {
  const items = demoRenderItems;

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
  // of whether the caller's `items` reference is stable (today's demo
  // fixture) or a fresh array each update (the real sync-engine-backed data
  // source this screen will eventually take).
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
}: {
  sessionId: string;
  items: RenderItem[];
  controlMode: "local" | "remote";
  working: boolean;
}) {
  const { mergedItems, send, isSending, isQueued, error } = useComposerState(items);

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
      <ControlBar mode="default" controlMode={controlMode} working={working} />
      <Timeline items={mergedItems} />
      <Composer onSend={send} isSending={isSending} isQueued={isQueued} error={error} />
    </div>
  );
}
