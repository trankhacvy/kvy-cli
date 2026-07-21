"use client";

import { decodeBase64 } from "@falcon/crypto/web";
import type { MachineRow } from "@falcon/wire";
import { useEffect, useMemo, useState } from "react";
import type { CryptoBridgeClient } from "@/crypto";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";
import { useMachineCrypto } from "@/lib/use-machine-crypto";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { apiSocket, createMachineRpcClient } from "@/sync";
import { machineRpcToActions } from "./live-actions";
import type { NewSessionActions, NewSessionMachine, UseNewSessionActions } from "./types";

/**
 * The New Session screen's real `UseNewSessionMachines`/`UseNewSessionActions`
 * (falcon-system-design.md §9.2 "New session" row, falcon-prd.md FR-7.5/UC5)
 * — swap-in replacements for `useMockNewSessionMachines`/
 * `useMockNewSessionActions` (`mock-source.ts`) at `new-session-screen.tsx`'s
 * call site.
 *
 * Machine list: the same `['sync']` snapshot `features/session-list/
 * live-source.ts` reads, decrypted the same way (`MachineRow.metadata`'s
 * `host` field) — kept as its own small decrypt loop here rather than
 * importing that feature's hook, so the two feature areas stay decoupled
 * (mirrors this codebase's existing `decryptMachineName` duplication
 * between the two rather than a shared cross-feature import).
 *
 * Actions: gated on `useMachineCrypto` (`@/lib/use-machine-crypto.ts`, the
 * shared per-machine DEK unwrap both this and `features/git-diff` need) —
 * every method rejects with an honest "not ready yet" message until the
 * chosen machine's key has unwrapped, never hangs or throws synchronously
 * during render (same "no silent failures" shape
 * `use-live-session-control.ts`'s `pendingSessionControl` uses).
 */

const UNNAMED_MACHINE = "(unnamed machine)";
const EMPTY_MACHINES: MachineRow[] = [];
const NOT_READY_MESSAGE = "Machine key isn't unwrapped yet — try again in a moment.";

/** Same online-presence heuristic as `features/session-list/live-source.ts`'s
 * `isMachineOnline` — duplicated rather than imported cross-feature, same
 * reasoning as `decryptMachineName` above. */
const MACHINE_ONLINE_WINDOW_MS = 3 * 60_000;
function isMachineOnline(machine: MachineRow, now: number): boolean {
  return machine.lastSeenAt !== null && now - machine.lastSeenAt <= MACHINE_ONLINE_WINDOW_MS;
}

async function decryptMachineName(
  bridge: CryptoBridgeClient,
  machine: MachineRow,
): Promise<string> {
  try {
    const ok = await bridge.setSessionKey(decodeBase64(machine.dek));
    if (!ok) return UNNAMED_MACHINE;
    const opened = await bridge.open<{ host?: unknown }>(machine.metadata.value);
    if (opened && typeof opened.host === "string" && opened.host.length > 0) {
      return opened.host;
    }
    return UNNAMED_MACHINE;
  } catch (err) {
    console.error(
      `new-session/live-source: failed to decrypt machine ${machine.id}'s metadata`,
      err,
    );
    return UNNAMED_MACHINE;
  }
}

function useDecryptedMachineNames(
  machines: MachineRow[],
  bridge: CryptoBridgeClient | null,
): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [versions] = useState(() => new Map<string, number>());

  useEffect(() => {
    if (!bridge) return;
    const toDecrypt = machines.filter((m) => versions.get(m.id) !== m.metadata.version);
    if (toDecrypt.length === 0) return;

    let cancelled = false;
    (async () => {
      const next = new Map<string, string>();
      for (const machine of toDecrypt) {
        if (cancelled) return;
        next.set(machine.id, await decryptMachineName(bridge, machine));
        versions.set(machine.id, machine.metadata.version);
      }
      if (cancelled) return;
      setNames((prev) => new Map([...prev, ...next]));
    })();

    return () => {
      cancelled = true;
    };
    // `versions` is a stable Map ref (useState initializer) used as a
    // mutable cache — listing it satisfies useExhaustiveDependencies and
    // never triggers a re-run, since the reference itself never changes.
  }, [bridge, machines, versions]);

  return names;
}

/** Real `UseNewSessionMachines` — the machine-picker step's data source. */
export function useLiveNewSessionMachines(): NewSessionMachine[] {
  const bridge = useCryptoBridge();
  const query = useSyncSnapshotQuery();
  const machineRows = query.data?.machines ?? EMPTY_MACHINES;
  const names = useDecryptedMachineNames(machineRows, bridge);

  return useMemo(() => {
    const now = Date.now();
    return machineRows.map((m) => ({
      id: m.id,
      name: names.get(m.id) ?? UNNAMED_MACHINE,
      online: isMachineOnline(m, now),
    }));
  }, [machineRows, names]);
}

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
