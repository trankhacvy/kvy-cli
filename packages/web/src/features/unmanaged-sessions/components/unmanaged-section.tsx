"use client";

import { useMemo } from "react";
import { useMockUnmanagedActions, useMockUnmanagedSessions } from "../mock-source";
import type { UseUnmanagedActions, UseUnmanagedSessionsSnapshot } from "../types";
import { UnmanagedSessionCard } from "./unmanaged-session-card";

/**
 * The unmanaged-session section (falcon-system-design.md §9.2 "Home" row:
 * `UnmanagedSection`; falcon-prd.md §5.9/UC9 "session adoption"). Rendered
 * on the Home screen alongside `SessionList`'s workspace groups — these
 * rows come from `unmanagedSessions` (the daemon transcript indexer's
 * upserts, design §8), a wholly separate track from Falcon-managed
 * `sessions` rows, so it stays its own section rather than folding into a
 * workspace group.
 *
 * `useSnapshot`/`useActions` are the injectable seams — same pattern as
 * `features/session-list`'s `UseSessionListSnapshot` /
 * `features/new-session`'s `UseNewSessionActions`: mock by default, swapped
 * for the real sync-engine-backed snapshot +
 * `(machineId) => machineRpcToUnmanagedActions(createMachineRpcClient({...}))`
 * once a screen has a live `apiSocket` + crypto client.
 */
export function UnmanagedSection({
  useSnapshot = useMockUnmanagedSessions,
  useActions = useMockUnmanagedActions,
}: {
  useSnapshot?: UseUnmanagedSessionsSnapshot;
  useActions?: UseUnmanagedActions;
}) {
  const snapshot = useSnapshot();
  const machinesById = useMemo(
    () => new Map(snapshot.machines.map((m) => [m.id, m])),
    [snapshot.machines],
  );

  if (snapshot.sessions.length === 0) return null;

  const sorted = [...snapshot.sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-sm font-medium text-muted-foreground">Unmanaged sessions</h2>
      <div className="flex flex-col gap-2">
        {sorted.map((session) => (
          <UnmanagedSessionCard
            key={session.id}
            session={session}
            machine={machinesById.get(session.machineId) ?? null}
            useActions={useActions}
          />
        ))}
      </div>
    </section>
  );
}
