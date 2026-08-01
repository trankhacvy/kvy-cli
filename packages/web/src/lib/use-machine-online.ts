"use client";

import {
  deriveMachineStatus,
  type MachineStatus,
  useMachinePresence,
} from "@/features/session-list";
import { useSyncSnapshotQuery } from "./use-sync-snapshot";

/**
 * One machine's live online/offline/needs-reauth state, for any feature that
 * is about to make a machine RPC (`sync/machineRpc.ts` — `git.*`, `fs.*`,
 * `run.*`, `preview.*`, `github.checks`, `spawn`).
 *
 * Lives in `lib/` rather than under `features/session-list/` for the same
 * reason `use-machine-crypto.ts` does: several feature areas need it, so
 * exactly one module should own it. It adds no new state — it composes the
 * existing `useMachinePresence` ephemeral subscription with the `['sync']`
 * snapshot's `MachineRow`, the same derivation
 * `components/timeline/SessionTimelineScreen.tsx` computes inline today.
 *
 * WHY THIS MATTERS AT ALL: the server's RPC relay waits out a reconnect
 * grace window before failing a call to a target that isn't in its room —
 * `RPC_RECONNECT_GRACE_MS = 15_000` plus a 2s initial lookup
 * (`packages/server/src/app/socket/rpcHandler.ts`). So a click against a
 * powered-off machine takes roughly 17 seconds to surface "RPC target not
 * available". That grace window is deliberate and should NOT be shortened —
 * it is what makes a daemon reconnect invisible. This hook is the
 * client-side answer instead: don't make the call.
 *
 * `"unknown"` is a real, common state, not an edge case. `machine-presence`
 * is only emitted on a machine socket's own connect/disconnect — there is no
 * periodic sweep and no retroactive snapshot for a web client that connects
 * later. `deriveMachineStatus` falls back to the `lastSeenAt` recency
 * heuristic until a live event or a synced row exists at all. Callers must
 * treat `"unknown"` as "go ahead and try", never as offline: blocking on a
 * machine we simply haven't heard about yet would break a working session.
 */
export type MachineAvailability = "online" | "offline" | "needs-reauth" | "unknown";

export interface MachineOnlineState {
  availability: MachineAvailability;
  /** `true` only for a confidently-offline or needs-reauth machine — the single boolean a caller should gate a button on. `false` for `"unknown"`. */
  isKnownUnavailable: boolean;
  /** Plain-language reason, or `null` when there's nothing to say. No internal vocabulary (CLAUDE.md auth/UX rule #4). */
  reason: string | null;
}

/** Exported so a caller that already has a `MachineStatus` from elsewhere
 * (e.g. `features/session-list`'s own `SessionListMachine.status`, already
 * live-derived by its `live-source.ts`) can build a consistent
 * `MachineOnlineState`-shaped notice without a second round-trip through
 * `useMachineOnline` itself — `new-session-panel.tsx`'s spawn-path Start
 * button is the first such caller. */
export const UNAVAILABLE_COPY: Record<Exclude<MachineStatus, "online">, string> = {
  offline: "This project's machine is offline right now.",
  "needs-reauth": "This project's machine needs to sign in again. Run `kvy auth login` there.",
};

export function useMachineOnline(machineId: string | null | undefined): MachineOnlineState {
  const presence = useMachinePresence();
  const snapshot = useSyncSnapshotQuery();
  const machine = machineId ? snapshot.data?.machines.find((m) => m.id === machineId) : undefined;

  if (!machine) {
    // The row hasn't synced yet (or there is no machine for this session) —
    // "unknown", never "offline". Same rule as `session-list/status.ts`,
    // where a `null` machineOnline deliberately does not produce "offline".
    return { availability: "unknown", isKnownUnavailable: false, reason: null };
  }

  const status = deriveMachineStatus(machine, presence, Date.now());
  if (status === "online") {
    return { availability: "online", isKnownUnavailable: false, reason: null };
  }
  return {
    availability: status,
    isKnownUnavailable: true,
    reason: UNAVAILABLE_COPY[status],
  };
}
