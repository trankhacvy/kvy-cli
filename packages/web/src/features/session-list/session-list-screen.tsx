"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  UnmanagedSection,
  type UseUnmanagedActions,
  type UseUnmanagedSessionsSnapshot,
  useMockUnmanagedActions,
  useMockUnmanagedSessions,
} from "@/features/unmanaged-sessions";
import { WorkspaceSection } from "./components/workspace-section";
import { groupSessionsByWorkspace } from "./group";
import { useMockSessionListData } from "./mock-source";
import type { UseSessionListSnapshot } from "./types";

/**
 * The Home screen (falcon-system-design.md §9.2 "Home" row; falcon-prd.md
 * FR-7.1): every session across machines, grouped by workspace, each with a
 * derived status dot and its machine's online/offline badge, plus the
 * unmanaged-session section (`UnmanagedSection`, falcon-prd.md §5.9/UC9)
 * underneath — plain claude/codex sessions the daemon's transcript indexer
 * found but Falcon never spawned.
 *
 * `useData`/`useUnmanagedSnapshot`/`useUnmanagedActions` are the injectable
 * seams: `apiSocket` and the sync engine aren't landed on `main` yet (plan.md
 * 1.6), so these default to static mock snapshots. Once the real
 * sync-engine-backed hooks exist they satisfy the same signatures and swap
 * in with no other change here — the same pattern the (unlanded) sync-engine
 * work uses for `SyncSocketSource`.
 */
export function SessionListScreen({
  useData = useMockSessionListData,
  useUnmanagedSnapshot = useMockUnmanagedSessions,
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
      <UnmanagedSection useSnapshot={useUnmanagedSnapshot} useActions={useUnmanagedActions} />
    </main>
  );
}
