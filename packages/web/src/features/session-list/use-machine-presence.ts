"use client";

import type { MachineRow } from "@kvy/wire";
import { useEffect, useState } from "react";
import type { EphemeralSource } from "@/features/session-control";
import { apiSocket } from "@/sync";

/**
 * Live machine online/offline (+ AH8 "machine-status-reauth" needs-reauth)
 * Shared between `features/session-list`'s own `live-source.ts` and
 * `features/unmanaged-sessions`' — both screens render machine badges for
 * what can be the very same machine, so both should agree on its live state
 * rather than each reinventing the subscription.
 *
 * `machine-presence` is only *emitted* on a machine-scoped socket's own
 * connect/disconnect (`server/src/app/socket.ts`) — a web client that
 * connects while a machine is already online gets no retroactive snapshot,
 * so this map starts empty and `deriveMachineOnline`/`deriveMachineStatus`
 * below fall back to the `lastSeenAt` heuristic (and `MachineRow.needsReauth`)
 * until this machine's first live event arrives.
 */

/** One machine's live presence — `needsReauth` (docs/auth-ux-hardening-plan.md
 * item 8) is only ever `true` on the disconnect path, when the server has
 * inferred this machine's `cli-daemon` device session is revoked; absent
 * (not `false`) for every other event, mirroring the wire ephemeral's own
 * "omitted means no" shape. */
export interface MachinePresence {
  online: boolean;
  needsReauth?: boolean;
}

export function useMachinePresence(
  source: EphemeralSource = apiSocket,
): Map<string, MachinePresence> {
  const [presence, setPresence] = useState<Map<string, MachinePresence>>(new Map());

  // biome-ignore lint/correctness/useExhaustiveDependencies: `source` is a stable singleton by default (apiSocket) or a test double the caller controls — subscribe once for the component's lifetime.
  useEffect(() => {
    return source.on("ephemeral", (event) => {
      if (event.t !== "machine-presence") return;
      setPresence((prev) => {
        const next: MachinePresence = { online: event.online, needsReauth: event.needsReauth };
        const current = prev.get(event.machineId);
        if (
          current?.online === next.online &&
          (current?.needsReauth ?? false) === (next.needsReauth ?? false)
        ) {
          return prev;
        }
        const updated = new Map(prev);
        updated.set(event.machineId, next);
        return updated;
      });
    });
  }, []);

  return presence;
}

/** Same online-presence heuristic as `features/session-list/live-source.ts`'s
 * `isMachineOnline` — mirrored in `features/new-session/live-source.ts`, which
 * doesn't consult live presence and duplicates it standalone (see that
 * file's own comment). `machineClient.ts`'s `heartbeatIntervalMs`, 60s by
 * default. */
export const MACHINE_ONLINE_WINDOW_MS = 3 * 60_000;

function isMachineOnlineHeuristic(machine: MachineRow, now: number): boolean {
  return machine.lastSeenAt !== null && now - machine.lastSeenAt <= MACHINE_ONLINE_WINDOW_MS;
}

/** The live `machine-presence` ephemeral wins once one has arrived for this
 * machine; until then, degrade honestly to the `lastSeenAt` recency
 * heuristic rather than guessing "online". */
export function deriveMachineOnline(
  machine: MachineRow,
  presence: Map<string, MachinePresence>,
  now: number,
): boolean {
  const live = presence.get(machine.id);
  if (live) return live.online;
  return isMachineOnlineHeuristic(machine, now);
}

/**
 * AH8 "machine-status-reauth" (docs/auth-ux-hardening-plan.md item 8): the
 * three-way status the Home screen's machine badge renders — a daemon that's
 * running but can't authenticate (`needs-reauth`) looks identical to a
 * powered-off machine (`offline`) under the plain boolean `online` alone, so
 * this is a distinct value, not just a color choice layered on top of
 * `deriveMachineOnline`.
 *
 * Priority: a live event wins outright (it's the freshest truth available);
 * failing that, the bootstrap `MachineRow.needsReauth` (server-inferred from
 * "most recent `cli-daemon` `device_sessions` row for this machine is
 * revoked", `machineReauth.ts`) is checked before falling back to the same
 * `lastSeenAt` recency heuristic `deriveMachineOnline` uses.
 */
export type MachineStatus = "online" | "offline" | "needs-reauth";

export function deriveMachineStatus(
  machine: MachineRow,
  presence: Map<string, MachinePresence>,
  now: number,
): MachineStatus {
  const live = presence.get(machine.id);
  if (live) {
    if (live.needsReauth) return "needs-reauth";
    return live.online ? "online" : "offline";
  }
  if (machine.needsReauth) return "needs-reauth";
  return isMachineOnlineHeuristic(machine, now) ? "online" : "offline";
}
