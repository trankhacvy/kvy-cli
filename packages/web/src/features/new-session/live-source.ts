"use client";

import { useMemo } from "react";
import { useMachineCrypto } from "@/lib/use-machine-crypto";
import { apiSocket, createMachineRpcClient } from "@/sync";
import { machineRpcToActions } from "./live-actions";
import type { NewSessionActions, UseNewSessionActions } from "./types";

/**
 * (`@/lib/use-machine-crypto.ts`, the shared per-machine DEK unwrap both
 * this and `features/git-diff` need); every method rejects with an honest
 * "not ready yet" message until the chosen machine's key has unwrapped,
 * never hangs or throws synchronously during render (same "no silent
 * failures" shape `use-live-session-control.ts`'s `pendingSessionControl`
 * uses).
 *
 * B5/B6 (new-session-from-web redesign, see the task's own header comment):
 * this module used to also export `useLiveNewSessionMachines` — the old
 * wizard's machine-picker step's data source. It's gone along with
 * `MachineStep`: the workspace-row `+` flow always already knows which
 * machine(s) a workspace's sessions have run on (B1's
 * `features/session-list/target-machine.ts`), sourced from the *live*
 * session-list snapshot (`features/session-list/live-source.ts`, which
 * already subscribes to real `machine-presence` via `use-machine-presence.ts`)
 * rather than re-deriving a second, independent machine list here. That
 * removes the exact bug B6 called out: `useLiveNewSessionMachines` computed
 * online/offline from a bare `lastSeenAt` recency heuristic instead of
 * subscribing to the live presence ephemeral — there is simply no code path
 * left that does that anymore, rather than a heuristic that was patched to
 * match `use-machine-presence.ts`.
 */

const NOT_READY_MESSAGE = "Machine key isn't unwrapped yet. Try again in a moment.";

/** Every method rejects with the same message until `useMachineCrypto`
 * resolves. Structurally satisfies `NewSessionActions`. */
function pendingNewSessionActions(): NewSessionActions {
  const notReady = () => Promise.reject(new Error(NOT_READY_MESSAGE));
  return {
    browseDirectory: notReady,
    createDirectory: notReady,
    registerWorkspace: notReady,
    spawn: notReady,
    listImportCandidates: notReady,
    listBranches: notReady,
    getConfig: notReady,
  };
}

/** Real `UseNewSessionActions` — one machine RPC actions client per chosen
 * machine, mirroring `features/session-control`'s `useLiveSessionControl`. */
export const useLiveNewSessionActions: UseNewSessionActions = (machineId) => {
  const crypto = useMachineCrypto(machineId);

  return useMemo(() => {
    if (!crypto || machineId === "") return pendingNewSessionActions();
    return machineRpcToActions(createMachineRpcClient({ socket: apiSocket, crypto, machineId }));
  }, [crypto, machineId]);
};
