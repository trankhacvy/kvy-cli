"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useDebouncedOrder } from "@/hooks/use-debounced-order";
import { FirstMachineOnboarding } from "./components/first-machine-onboarding";
import { NewWorkspaceTrigger } from "./components/new-workspace-panel";
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
 * The Home screen (kvy-system-design.md §9.2 "Home" row; kvy-prd.md
 * FR-7.1): every session across machines, grouped by workspace, each with a
 * derived status dot and its machine's online/offline badge.
 *
 * `useData` defaults to the real sync-engine-backed `useLiveSessionListSnapshot`
 * (`live-source.ts`), mirroring `SessionTimelineScreen`'s own `useControl`
 * default. `useData` stays an injectable prop so a test can still pass a
 * fixture snapshot without touching `WorkspaceSection`/`SessionCard`.
 *
 * The `features/unmanaged-sessions` section (plain claude/codex sessions the
 * daemon's transcript indexer found but Kvy never spawned) is
 * intentionally NOT rendered here right now — a `kvy claude` session can
 * itself show up as a false-positive "unmanaged" duplicate of its own
 * managed card when the daemon's "this one's already mine" self-report lands
 * late or is missing for a given launch path (open gap for the
 * `runRemoteLoop` path). Hidden rather than deleted: the feature code under
 * `features/unmanaged-sessions/` and its route are untouched, just not wired
 * into this screen or reachable, pending a fix.
 *

 * Archived sessions are excluded here — they live on the dedicated
 * `/completed/` screen (`CompletedSessionsScreen`) instead. `group.ts` itself
 * stays filter-free so that screen can reuse the exact same
 * `groupSessionsByWorkspace` over the complementary (archived-only) subset.
 *
 * B5 (new-session-from-web redesign, see the task's own header comment): the
 * old standalone "New session" wizard/route is retired — a session now
 * always starts from the `+` on an existing `WorkspaceSection` row
 * (`components/new-session-panel.tsx`), since a workspace only exists
 * server-side once `kvy` has actually run there once. That used to leave
 * one genuine gap: an account with machines but literally zero sessions
 * ever run had no workspace row to put a `+` on yet. Feature 4 (docs/
 * web-ux-improvements-plan.md) closes it — `NewWorkspaceTrigger`
 * (`components/new-workspace-panel.tsx`) creates a brand-new folder on a
 * machine, registers it, and spawns the first session there, with no
 * terminal required (CLAUDE.md auth/UX rule #1: never print "run X" when
 * you can run X). It's offered both in the "no sessions yet" empty state and
 * in the header once sessions already exist.
 */
export function SessionListScreen({
  useData = useLiveSessionListSnapshot,
}: {
  useData?: UseSessionListSnapshot;
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

  // Skeleton only for the true first-load window: the initial account fetch
  // is in flight and nothing has rendered yet. A later refetch
  // (gap-invalidation, reconnect) never re-shows this; it just keeps
  // whatever was already on screen (plan-v2.md W4.2 "skeletons for Home …
  // initial loads").
  if (snapshot.isLoading && groups.length === 0) {
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
  if (!hasMachines) {
    return <FirstMachineOnboarding />;
  }

  if (groups.length === 0) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm font-medium">No sessions yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Create a new project below, or run{" "}
          <code className="rounded bg-muted px-1 py-0.5">kvy</code> from an existing project on one
          of your machines. It shows up here automatically, and you'll be able to start more
          sessions in that same project right from here.
        </p>
        <NewWorkspaceTrigger machines={snapshot.machines} />
      </div>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Sessions</h1>
        <div className="flex items-center gap-2">
          <NewWorkspaceTrigger machines={snapshot.machines} />
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
    </main>
  );
}
