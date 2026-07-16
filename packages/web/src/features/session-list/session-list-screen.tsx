"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { WorkspaceSection } from "./components/workspace-section";
import { groupSessionsByWorkspace } from "./group";
import { useMockSessionListData } from "./mock-source";
import type { UseSessionListSnapshot } from "./types";

/**
 * The Home screen (falcon-system-design.md §9.2 "Home" row; falcon-prd.md
 * FR-7.1): every session across machines, grouped by workspace, each with a
 * derived status dot and its machine's online/offline badge.
 *
 * `useData` is the injectable seam: `apiSocket` and the sync engine aren't
 * landed on `main` yet (plan.md 1.6), so this defaults to a static mock
 * snapshot. Once the real sync-engine-backed hook exists it satisfies the
 * same `UseSessionListSnapshot` signature and swaps in with no other change
 * here — the same pattern the (unlanded) sync-engine work uses for
 * `SyncSocketSource`.
 */
export function SessionListScreen({
  useData = useMockSessionListData,
}: {
  useData?: UseSessionListSnapshot;
}) {
  const snapshot = useData();
  const groups = useMemo(() => groupSessionsByWorkspace(snapshot), [snapshot]);
  const machinesById = useMemo(() => new Map(snapshot.machines.map((m) => [m.id, m])), [snapshot]);

  if (groups.length === 0) {
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
    </main>
  );
}
