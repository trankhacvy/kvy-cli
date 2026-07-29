"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  UnmanagedSection,
  type UseUnmanagedActions,
  type UseUnmanagedSessionsSnapshot,
  useLiveUnmanagedSessions,
  useMockUnmanagedActions,
} from "@/features/unmanaged-sessions";
import { useDebouncedOrder } from "@/hooks/use-debounced-order";
import { FirstMachineOnboarding } from "./components/first-machine-onboarding";
import { SessionListSkeleton } from "./components/session-list-skeleton";
import { WorkspaceSection } from "./components/workspace-section";
import { groupPagedSessions, type WorkspaceGroup } from "./group";
import { useLiveSessionListSnapshot } from "./live-source";
import type { UseSessionListSnapshot } from "./types";

const PAGE_SIZE = 10;
// Shorter than the sidebar's — this is a page you're actively viewing, so
// some liveliness in ordering is expected (docs/workspace-nav-redesign-plan.md
// decision #6).
const REORDER_DEBOUNCE_MS = 1500;

function workspaceKey(group: WorkspaceGroup): string {
  return group.workspace.id;
}

/**
 * The Home screen (falcon-system-design.md §9.2 "Home" row; falcon-prd.md
 * FR-7.1): every session across machines, grouped by workspace, each with a
 * derived status dot and its machine's online/offline badge, plus the
 * unmanaged-session section (`UnmanagedSection`, falcon-prd.md §5.9/UC9)
 * underneath — plain claude/codex sessions the daemon's transcript indexer
 * found but Falcon never spawned.
 *
 * `useData` defaults to the real sync-engine-backed `useLiveSessionListSnapshot`
 * (`live-source.ts`), mirroring `SessionTimelineScreen`'s own `useControl`
 * default. `useData` stays an injectable prop so a test can still pass a
 * fixture snapshot without touching `WorkspaceSection`/`SessionCard`.
 *
 * `useUnmanagedSnapshot` defaults to the real `useLiveUnmanagedSessions`
 * (`features/unmanaged-sessions/live-source.ts`) — same `['sync']` snapshot,
 * live rows. `useUnmanagedActions` stays mock-backed: the `adopt.mirror`/
 * `adopt.take` RPCs need a live per-machine crypto client this screen
 * doesn't have yet (plan.md §16 W3.10's own scope note), so `actionsDisabled`
 * is passed alongside it to grey out `UnmanagedSection`'s "View"/"Take over"
 * entry points instead of letting them silently pretend to succeed against a
 * real row.
 *
 * Archived ("Mark done") sessions are excluded here (docs/features/
 * session-lifecycle-actions.md Phase 5) — they live on the dedicated
 * `/completed/` screen (`CompletedSessionsScreen`) instead. `group.ts` itself
 * stays filter-free so that screen can reuse the exact same
 * `groupSessionsByWorkspace` over the complementary (archived-only) subset.
 *
 * B5 (new-session-from-web redesign, see the task's own header comment): the
 * old standalone "New session" wizard/route is retired — a session now
 * always starts from the `+` on an existing `WorkspaceSection` row
 * (`components/new-session-panel.tsx`), since a workspace only exists
 * server-side once `falcon` has actually run there once. That leaves one
 * genuine gap this screen still has to cover honestly: an account with
 * machines but literally zero sessions ever run has no workspace row to put
 * a `+` on yet. That "no sessions yet" branch below shows static
 * CLI-pointing guidance (mirroring `FirstMachineOnboarding`'s tone) instead
 * of a button, rather than keeping a dead link to a removed route alive.
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
  const activeSnapshot = useMemo(
    () => ({
      ...snapshot,
      sessions: snapshot.sessions.filter((s) => s.status !== "archived"),
    }),
    [snapshot],
  );
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const pagedSessions = useMemo(
    () =>
      [...activeSnapshot.sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, visibleCount),
    [activeSnapshot.sessions, visibleCount],
  );
  const groups = useMemo(
    () => groupPagedSessions(pagedSessions, activeSnapshot.workspaces),
    [pagedSessions, activeSnapshot.workspaces],
  );
  const [paused, setPaused] = useState(false);
  const stableGroups = useDebouncedOrder(groups, workspaceKey, REORDER_DEBOUNCE_MS, paused);
  const hasMore = activeSnapshot.sessions.length > visibleCount;
  const machinesById = useMemo(() => new Map(snapshot.machines.map((m) => [m.id, m])), [snapshot]);
  const hasMachines = snapshot.machines.length > 0;
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

  // No machines at all is a DIFFERENT state from "machines, but no sessions": the old
  // copy pointed at a "paired machine" the user did not have, and offered a button that
  // needs one.
  if (!hasMachines && unmanagedSnapshot.sessions.length === 0) {
    return <FirstMachineOnboarding />;
  }

  if (groups.length === 0 && unmanagedSnapshot.sessions.length === 0) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm font-medium">No sessions yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Run <code className="rounded bg-muted px-1 py-0.5">falcon</code> from a project on one of
          your machines to start one — it shows up here automatically, and you'll be able to start
          more sessions in that same project right from here.
        </p>
      </div>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Sessions</h1>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/completed/">Completed</Link>
          </Button>
        </div>
      </div>
      <div
        className="flex flex-col gap-6"
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
      >
        {stableGroups.map((group) => (
          <WorkspaceSection key={group.workspace.id} group={group} machinesById={machinesById} />
        ))}
      </div>
      {hasMore && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-center"
          onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
        >
          Load 10 more
        </Button>
      )}
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
