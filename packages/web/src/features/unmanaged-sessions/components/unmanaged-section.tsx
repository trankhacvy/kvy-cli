"use client";

import { useMemo } from "react";
import { useLiveUnmanagedSessions } from "../live-source";
import { useMockUnmanagedActions } from "../mock-source";
import type { UseUnmanagedActions, UseUnmanagedSessionsSnapshot } from "../types";
import { UnmanagedSessionCard } from "./unmanaged-session-card";

/**
 * The unmanaged-session section rendered on the Home screen alongside
 * `SessionList`'s workspace groups. Unmanaged sessions come from the daemon
 * transcript indexer's upserts — a wholly separate track from Kvy-managed
 * `sessions` rows.
 *
 * `useSnapshot` defaults to the real sync-engine-backed
 * `useLiveUnmanagedSessions`. `useActions` stays mock-backed by default: the
 * `adopt.mirror`/`adopt.take` RPCs need a live per-machine RPC/crypto client
 * no screen has yet — swap it for
 * `(machineId) => machineRpcToUnmanagedActions(createMachineRpcClient({...}))`
 * once that lands. Both remain injectable seams for tests.
 */
export function UnmanagedSection({
  useSnapshot = useLiveUnmanagedSessions,
  useActions = useMockUnmanagedActions,
  actionsDisabled = false,
}: {
  useSnapshot?: UseUnmanagedSessionsSnapshot;
  useActions?: UseUnmanagedActions;
  actionsDisabled?: boolean;
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
            actionsDisabled={actionsDisabled}
          />
        ))}
      </div>
    </section>
  );
}
