"use client";

import { decodeBase64 } from "@kvy/crypto/web";
import type { MachineRow, UnmanagedSessionRow } from "@kvy/wire";
import { useEffect, useMemo, useState } from "react";
import type { CryptoBridgeClient } from "@/crypto";
import {
  deriveMachineOnline,
  deriveMachineStatus,
  type MachinePresence,
  type SessionListMachine,
  useMachinePresence,
} from "@/features/session-list";
import { useDedicatedCryptoBridge } from "@/lib/use-crypto-bridge";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import type {
  UnmanagedSessionItem,
  UnmanagedSessionsSnapshot,
  UseUnmanagedSessionsSnapshot,
} from "./types";


const UNTITLED = "(untitled session)";
const UNNAMED_MACHINE = "(unnamed machine)";
const EMPTY_ROWS: UnmanagedSessionRow[] = [];
const EMPTY_MACHINES: MachineRow[] = [];

interface DecryptedUnmanaged {
  summaries: Map<string, { title: string; lastActivity: number; running: boolean }>;
  machineNames: Map<string, string>;
}

const EMPTY_DECRYPTED: DecryptedUnmanaged = { summaries: new Map(), machineNames: new Map() };

async function decryptSummary(
  bridge: CryptoBridgeClient,
  row: UnmanagedSessionRow,
): Promise<{ title: string; lastActivity: number; running: boolean } | null> {
  try {
    const ok = await bridge.setSessionKey(decodeBase64(row.dek));
    if (!ok) return null;
    const opened = await bridge.open<{
      title?: unknown;
      lastActivity?: unknown;
      running?: unknown;
    }>(row.summary);
    if (!opened) return null;
    return {
      title: typeof opened.title === "string" && opened.title.length > 0 ? opened.title : UNTITLED,
      lastActivity: typeof opened.lastActivity === "number" ? opened.lastActivity : row.updatedAt,
      running: typeof opened.running === "boolean" ? opened.running : false,
    };
  } catch (err) {
    console.error(`unmanaged-sessions/live-source: failed to decrypt row ${row.id}'s summary`, err);
    return null;
  }
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
      `unmanaged-sessions/live-source: failed to decrypt machine ${machine.id}'s name`,
      err,
    );
    return UNNAMED_MACHINE;
  }
}

/** Decrypts every unmanaged row's summary + every machine's name, re-running
 * only for rows/machines this hook hasn't already decrypted at their current
 * freshness key (`row.updatedAt` / `machine.metadata.version`). */
function useDecryptedUnmanaged(
  rows: UnmanagedSessionRow[],
  machines: MachineRow[],
  bridge: CryptoBridgeClient | null,
): DecryptedUnmanaged {
  const [decrypted, setDecrypted] = useState<DecryptedUnmanaged>(EMPTY_DECRYPTED);
  const [versions] = useState(() => new Map<string, number>());

  useEffect(() => {
    if (!bridge) return;
    const rowsToDecrypt = rows.filter((r) => versions.get(`u:${r.id}`) !== r.updatedAt);
    const machinesToDecrypt = machines.filter(
      (m) => versions.get(`m:${m.id}`) !== m.metadata.version,
    );
    if (rowsToDecrypt.length === 0 && machinesToDecrypt.length === 0) return;

    let cancelled = false;
    (async () => {
      const nextSummaries = new Map<
        string,
        { title: string; lastActivity: number; running: boolean }
      >();
      for (const row of rowsToDecrypt) {
        if (cancelled) return;
        const summary = await decryptSummary(bridge, row);
        if (summary) nextSummaries.set(row.id, summary);
        versions.set(`u:${row.id}`, row.updatedAt);
      }
      const nextMachineNames = new Map<string, string>();
      for (const machine of machinesToDecrypt) {
        if (cancelled) return;
        nextMachineNames.set(machine.id, await decryptMachineName(bridge, machine));
        versions.set(`m:${machine.id}`, machine.metadata.version);
      }
      if (cancelled) return;
      setDecrypted((prev) => ({
        summaries: new Map([...prev.summaries, ...nextSummaries]),
        machineNames: new Map([...prev.machineNames, ...nextMachineNames]),
      }));
    })();

    return () => {
      cancelled = true;
    };
    // `versions` is a stable Map ref (useState initializer) used as a
    // mutable cache — listing it satisfies useExhaustiveDependencies and
    // never triggers a re-run, since the reference itself never changes.
  }, [bridge, rows, machines, versions]);

  return decrypted;
}

/** Exported for `live-source.test.ts` — assembles the final
 * `UnmanagedSessionsSnapshot` from already-resolved inputs (no async/effect
 * involved), so tests can exercise the real assembly logic deterministically. */
export function buildSnapshot(
  rows: UnmanagedSessionRow[],
  machineRows: MachineRow[],
  decrypted: DecryptedUnmanaged,
  presence: Map<string, MachinePresence>,
): UnmanagedSessionsSnapshot {
  const now = Date.now();

  const machineIds = new Set(rows.map((r) => r.machineId));
  const machines: SessionListMachine[] = machineRows
    .filter((m) => machineIds.has(m.id))
    .map((m) => ({
      id: m.id,
      name: decrypted.machineNames.get(m.id) ?? UNNAMED_MACHINE,
      online: deriveMachineOnline(m, presence, now),
      // same badge status `features/session-list/live-source.ts` computes -
      // this section reuses `MachineBadge` for the same machine, so both must agree
      status: deriveMachineStatus(m, presence, now),
    }));

  const sessions: UnmanagedSessionItem[] = rows.map((r) => {
    const summary = decrypted.summaries.get(r.id);
    return {
      id: r.id,
      machineId: r.machineId,
      workspaceId: r.workspaceId,
      providerRef: r.providerRef,
      title: summary?.title ?? UNTITLED,
      lastActivityAt: summary?.lastActivity ?? r.updatedAt,
      running: summary?.running ?? false,
      updatedAt: r.updatedAt,
    };
  });

  return { machines, sessions };
}

/** Real `UseUnmanagedSessionsSnapshot` — swap-in replacement for
 * `useMockUnmanagedSessions` (`mock-source.ts`) at the Home screen's call
 * site. Returns an empty snapshot until the account snapshot has loaded and
 * the crypto bridge is ready, same "never crash on absent data" shape the
 * mock's static fixture doesn't need to worry about. */
export const useLiveUnmanagedSessions: UseUnmanagedSessionsSnapshot = () => {
  const bridge = useDedicatedCryptoBridge();
  const query = useSyncSnapshotQuery();
  const presence = useMachinePresence();

  const rows = query.data?.unmanagedSessions ?? EMPTY_ROWS;
  const machineRows = query.data?.machines ?? EMPTY_MACHINES;
  const decrypted = useDecryptedUnmanaged(rows, machineRows, bridge);

  return useMemo(
    () => buildSnapshot(rows, machineRows, decrypted, presence),
    [rows, machineRows, decrypted, presence],
  );
};
