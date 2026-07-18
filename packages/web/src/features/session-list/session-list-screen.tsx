"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  UnmanagedSection,
  type UseUnmanagedActions,
  type UseUnmanagedSessionsSnapshot,
  useLiveUnmanagedSessions,
  useMockUnmanagedActions,
} from "@/features/unmanaged-sessions";
import { SessionListSkeleton } from "./components/session-list-skeleton";
import { WorkspaceSection } from "./components/workspace-section";
import { groupSessionsByWorkspace } from "./group";
import { useLiveSessionListSnapshot } from "./live-source";
import type { UseSessionListSnapshot } from "./types";

/**
 * The Home screen (falcon-system-design.md §9.2 "Home" row; falcon-prd.md
 * FR-7.1): every session across machines, grouped by workspace, each with a
 * derived status dot and its machine's online/offline badge, plus the
 * unmanaged-session section (`UnmanagedSection`, falcon-prd.md §5.9/UC9)
 * underneath — plain claude/codex sessions the daemon's transcript indexer
 * found but Falcon never spawned.
 *
 * `useData` defaults to the real sync-engine-backed `useLiveSessionListSnapshot`
 * (`live-source.ts`) — the hand-built `mock-source.ts` fixture this screen
 * used to default to is retired from this call site (still exported, for
 * tests/Storybook-less component review, from `features/session-list`),
 * mirroring `SessionTimelineScreen`'s own `useControl` swap. `useData` stays
 * an injectable prop so a test can still pass `useMockSessionListData`
 * without touching `WorkspaceSection`/`SessionCard`.
 *
 * `useUnmanagedSnapshot` defaults to the real `useLiveUnmanagedSessions`
 * (`features/unmanaged-sessions/live-source.ts`) — same `['sync']` snapshot,
 * live rows. `useUnmanagedActions` stays mock-backed: the `adopt.mirror`/
 * `adopt.take` RPCs need a live per-machine crypto client this screen
 * doesn't have yet (plan.md §16 W3.10's own scope note), so `actionsDisabled`
 * is passed alongside it to grey out `UnmanagedSection`'s "View"/"Take over"
 * entry points instead of letting them silently pretend to succeed against a
 * real row.
 */
export function SessionListScreen({
  useData = useLiveSessionListSnapshot,
  useUnmanagedSnapshot = useLiveUnmanagedSessions,
  useUnmanagedActions = useMockUnmanagedActions,
}: {
  useData?: UseSessionListSnapshot;
  useUnmanagedSnapshot?: UseUnmanagedSessionsSnapshot;
  useUnmanagedActions?: UseUnmanagedActions;
}) {
  const snapshot = useData();
  const groups = useMemo(() => groupSessionsByWorkspace(snapshot), [snapshot]);
  const machinesById = useMemo(() => new Map(snapshot.machines.map((m) => [m.id, m])), [snapshot]);
  const unmanagedSnapshot = useUnmanagedSnapshot();

  // Skeleton only for the true first-load window: the initial account fetch
  // is in flight and nothing — session or unmanaged — has rendered yet. A
  // later refetch (gap-invalidation, reconnect) never re-shows this; it just
  // keeps whatever was already on screen (plan-v2.md W4.2 "skeletons for
  // Home … initial loads").
  if (snapshot.isLoading && groups.length === 0 && unmanagedSnapshot.sessions.length === 0) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight">Sessions</h1>
        </div>
        <SessionListSkeleton />
      </main>
    );
  }

  if (groups.length === 0 && unmanagedSnapshot.sessions.length === 0) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm font-medium">No sessions yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Run <code className="rounded bg-muted px-1 py-0.5">falcon</code> from a project on any
          paired machine to start one — it shows up here automatically. Or spawn one remotely:
        </p>
        <Button asChild>
          <Link href="/session/new/">New session</Link>
        </Button>
      </div>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Sessions</h1>
        <Button asChild size="sm">
          <Link href="/session/new/">New session</Link>
        </Button>
      </div>
      {groups.map((group) => (
        <WorkspaceSection key={group.workspace.id} group={group} machinesById={machinesById} />
      ))}
      <UnmanagedSection
        useSnapshot={useUnmanagedSnapshot}
        useActions={useUnmanagedActions}
        // `adopt.mirror`/`adopt.take` have no live per-machine crypto client
        // wired into this screen yet (see this component's own doc comment)
        // — hardcoded true, not a prop, since it tracks this call site's
        // actual capability rather than being something a caller should
        // toggle independently of which `useUnmanagedActions` is plugged in.
        actionsDisabled
      />
    </main>
  );
}
