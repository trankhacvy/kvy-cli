"use client";

import Link from "next/link";
import { useMemo } from "react";
import { groupSessionsByWorkspace } from "../group";
import { useLiveSessionListSnapshot } from "../live-source";
import type { UseSessionListSnapshot } from "../types";
import { SessionListSkeleton } from "./session-list-skeleton";
import { WorkspaceSection } from "./workspace-section";

/**
 * The Completed Chats screen (docs/features/session-lifecycle-actions.md
 * Phase 5) — the "Mark done" destination: same shape as `SessionListScreen`
 * (reusing `groupSessionsByWorkspace`/`WorkspaceSection`/`SessionCard` as-is),
 * but showing ONLY `status === "archived"` sessions, with no `UnmanagedSection`
 * and no "New session" CTA (there's nothing to spawn from here). Restore
 * (`SessionCardActions`' archived branch) is each row's way back to Home.
 *
 * `useData` defaults to the same real `useLiveSessionListSnapshot` Home
 * uses — both screens read the identical `['sync']` snapshot and simply
 * filter it to complementary subsets, matching `session-list-screen.tsx`'s
 * own doc comment on why `group.ts` itself stays filter-free.
 */
export function CompletedSessionsScreen({
  useData = useLiveSessionListSnapshot,
}: {
  useData?: UseSessionListSnapshot;
}) {
  const snapshot = useData();
  const archivedSnapshot = useMemo(
    () => ({ ...snapshot, sessions: snapshot.sessions.filter((s) => s.status === "archived") }),
    [snapshot],
  );
  const groups = useMemo(() => groupSessionsByWorkspace(archivedSnapshot), [archivedSnapshot]);
  const machinesById = useMemo(() => new Map(snapshot.machines.map((m) => [m.id, m])), [snapshot]);

  if (snapshot.isLoading && groups.length === 0) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
        <Header />
        <SessionListSkeleton />
      </main>
    );
  }

  if (groups.length === 0) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
        <Header />
        <div className="flex min-h-[30vh] flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm font-medium">Nothing completed yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">Mark done moves sessions here.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <Header />
      {groups.map((group) => (
        <WorkspaceSection key={group.workspace.id} group={group} machinesById={machinesById} />
      ))}
    </main>
  );
}

function Header() {
  return (
    <div className="flex items-center justify-between">
      <h1 className="text-lg font-semibold tracking-tight">Completed Chats</h1>
      <Link
        href="/dashboard/"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        Back to Home
      </Link>
    </div>
  );
}
