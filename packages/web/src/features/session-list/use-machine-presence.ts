"use client";

import type { MachineRow } from "@falcon/wire";
import { useEffect, useState } from "react";
import type { EphemeralSource } from "@/features/session-control";
import { apiSocket } from "@/sync";

/**
 * Live machine online/offline signal from the `machine-presence` ephemeral
 * (falcon-system-design.md §4.3, plan.md §16 W3.6 "Home screen real status
 * dots + presence"). Shared between `features/session-list`'s own
 * `live-source.ts` and `features/unmanaged-sessions`' — both screens render
 * machine badges for what can be the very same machine, so both should agree
 * on its live state rather than each reinventing the subscription.
 *
 * `machine-presence` is only *emitted* on a machine-scoped socket's own
 * connect/disconnect (`server/src/app/socket.ts`) — a web client that
 * connects while a machine is already online gets no retroactive snapshot,
 * so this map starts empty and `deriveMachineOnline` below falls back to the
 * `lastSeenAt` heuristic until this machine's first live event arrives.
 */
export function useMachinePresence(source: EphemeralSource = apiSocket): Map<string, boolean> {
  const [online, setOnline] = useState<Map<string, boolean>>(new Map());

  // biome-ignore lint/correctness/useExhaustiveDependencies: `source` is a stable singleton by default (apiSocket) or a test double the caller controls — subscribe once for the component's lifetime.
  useEffect(() => {
    return source.on("ephemeral", (event) => {
      if (event.t !== "machine-presence") return;
      setOnline((prev) => {
        if (prev.get(event.machineId) === event.online) return prev;
        const next = new Map(prev);
        next.set(event.machineId, event.online);
        return next;
      });
    });
  }, []);

  return online;
}

/** A machine is considered online if its heartbeat (`machineClient.ts`'s
 * `heartbeatIntervalMs`, 60s by default) landed within this window — three
 * missed beats' worth of slack — used only as the bootstrap fallback before
 * `useMachinePresence` has ever heard a live `machine-presence` event for
 * this particular machine (see `deriveMachineOnline`). */
export const MACHINE_ONLINE_WINDOW_MS = 3 * 60_000;

function isMachineOnlineHeuristic(machine: MachineRow, now: number): boolean {
  return machine.lastSeenAt !== null && now - machine.lastSeenAt <= MACHINE_ONLINE_WINDOW_MS;
}

/** The live `machine-presence` ephemeral wins once one has arrived for this
 * machine; until then, degrade honestly to the `lastSeenAt` recency
 * heuristic rather than guessing "online". */
export function deriveMachineOnline(
  machine: MachineRow,
  presence: Map<string, boolean>,
  now: number,
): boolean {
  const live = presence.get(machine.id);
  return live ?? isMachineOnlineHeuristic(machine, now);
}
