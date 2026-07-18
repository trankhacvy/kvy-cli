"use client";

import { decodeBase64 } from "@falcon/crypto/web";
import type { MachineRow, UnmanagedSessionRow } from "@falcon/wire";
import { useEffect, useMemo, useState } from "react";
import type { CryptoBridgeClient } from "@/crypto";
import {
  deriveMachineOnline,
  type SessionListMachine,
  useMachinePresence,
} from "@/features/session-list";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import type {
  UnmanagedSessionItem,
  UnmanagedSessionsSnapshot,
  UseUnmanagedSessionsSnapshot,
} from "./types";

/**
 * The Home screen's real `UseUnmanagedSessionsSnapshot` (falcon-system-design.md
 * §9.2 "Home" row: `UnmanagedSection`; plan.md §16 W3.10 "Unmanaged sessions
 * -> live"). Same seam/shape as `features/session-list/live-source.ts`'s
 * `useLiveSessionListSnapshot` — reads the same `['sync']` account snapshot
 * (`useSyncSnapshotQuery`), so an `unmanaged-new`/`unmanaged-update` WS event
 * (the daemon transcript indexer's upserts, design §8) updates this section
 * with no second sync mechanism. `useMachinePresence`/`deriveMachineOnline`
 * are the exact same shared helpers `live-source.ts` uses, so a machine
 * showing in both the managed session list and this section agrees on its
 * online state.
 *
 * Decryption mirrors `live-source.ts`'s `useDecryptedTitles`: one shared
 * bridge, one row unwrapped + opened at a time (a crypto-bridge worker only
 * ever holds one active session key at once), re-running only for rows
 * whose `updatedAt` moved since the last decrypt (`UnmanagedSessionRow.summary`
 * carries no `.version` the way `metadata`/`agentState` do, so `updatedAt` —
 * bumped on every upsert, `packages/server/src/app/routes/unmanagedSessions.ts`
 * — is the freshness signal here instead).
 *
 * Read-only by design (plan.md's W3.10 brief: "Actions (mirror/adopt) stay
 * disabled until the adopt RPCs get live wiring — render read-only rows
 * first"): this module only ever produces the *snapshot* half of the
 * section. `useMockUnmanagedActions` stays the default `useActions` at the
 * Home screen's call site, and `session-list-screen.tsx` now passes
 * `actionsDisabled` alongside it so `UnmanagedSection`/`UnmanagedSessionCard`
 * grey out "View"/"Take over" rather than let a real row silently drive a
 * mocked action that only *pretends* to mirror/adopt it.
 */

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
  presence: Map<string, boolean>,
): UnmanagedSessionsSnapshot {
  const now = Date.now();

  const machineIds = new Set(rows.map((r) => r.machineId));
  const machines: SessionListMachine[] = machineRows
    .filter((m) => machineIds.has(m.id))
    .map((m) => ({
      id: m.id,
      name: decrypted.machineNames.get(m.id) ?? UNNAMED_MACHINE,
      online: deriveMachineOnline(m, presence, now),
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
  const bridge = useCryptoBridge();
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
