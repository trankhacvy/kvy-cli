"use client";

import { decodeBase64 } from "@falcon/crypto/web";
import type { MachineRow, SessionRow } from "@falcon/wire";
import { useEffect, useMemo, useState } from "react";
import type { CryptoBridgeClient } from "@/crypto";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import type {
  SessionListMachine,
  SessionListSession,
  SessionListSnapshot,
  SessionListWorkspace,
  UseSessionListSnapshot,
} from "./types";

/**
 * The Home screen's real `UseSessionListSnapshot` (falcon-system-design.md
 * §9.2 "Home" row, falcon-prd.md FR-7.1). Mirrors the seam
 * `features/git-diff/live-actions.ts` / `features/unmanaged-sessions/
 * live-actions.ts` use for "the real, non-mock implementation" — swapped in
 * at `session-list-screen.tsx`'s call site in place of `useMockSessionListData`.
 *
 * Data source: `useSyncSnapshotQuery()` (`@/lib/use-sync-snapshot.ts`) — the
 * same `['sync']` TanStack Query cache + sync-engine wiring
 * `features/session-control` already uses, so a `session-new`/`session-
 * update`/`machine-update` WS event updates this screen without a manual
 * refresh (`sync/engine.ts`'s header fast-path), with no second sync
 * mechanism built here.
 *
 * Decryption: each session/machine's `metadata` is an `EncryptedBox` sealed
 * under its own row-level DEK (design §5.3) — `session.tag`/`machine.id`
 * carry no plaintext title. `useDecryptedTitles` below unwraps each row's
 * DEK (`bridge.setSessionKey`) and opens its metadata box
 * (`bridge.open`) one row at a time, since a crypto-bridge worker only ever
 * holds one *active* session key at once (`crypto/client.ts`'s
 * `setSessionKey` doc comment) — sequential `await`s, not a parallel
 * `Promise.all`, are required for correctness here, not just style. Failure
 * to decrypt a given row (bad/foreign DEK, corrupt box) never throws or
 * drops the row — it falls back to an honest placeholder, per this
 * codebase's "no silent failures, no silent data loss" design principle
 * (`@falcon/crypto`'s `open()` doc comment).
 *
 * Not yet wired (documented here as follow-ups, not blockers — see this
 * task's own scope note): per-session `items`/`attention` are always
 * `[]`/`null`, since deriving those needs each session's decrypted message
 * transcript (`features/session-control/use-live-render-items.ts`'s job,
 * out of scope for a session list of many sessions) or the live `ephemeral`
 * stream (`apiSocket.on('ephemeral', ...)`, `use-session-ephemerals.ts`'s
 * per-session pattern) fanned out across every visible session — a
 * reasonable next step, not required for a first real-data pass per this
 * task's brief. `machineOnline` is a `lastSeenAt`-recency heuristic, not the
 * live `machine-presence` ephemeral — same reasoning.
 */

/** A machine is considered online if its heartbeat (`machineClient.ts`'s
 * `heartbeatIntervalMs`, 60s by default) landed within this window — three
 * missed beats' worth of slack before flipping to "offline", rather than
 * subscribing to the live `machine-presence` ephemeral (a further follow-up,
 * see this module's doc comment). */
const MACHINE_ONLINE_WINDOW_MS = 3 * 60_000;

const UNTITLED_SESSION = "(untitled session)";
const UNNAMED_MACHINE = "(unnamed machine)";
const EMPTY_SESSIONS: SessionRow[] = [];
const EMPTY_MACHINES: MachineRow[] = [];

/** `session.workspaceId` (when set) *is* a workspace's registered real
 * absolute path — there's no separate workspace-name lookup on the server
 * (the `workspaces` table exists in `schema.ts` but no route ever
 * reads/writes it yet; `cli/src/workspace/registry.ts`'s own doc comment:
 * "that resolved path also *is* the workspace's `workspaceId` everywhere").
 * So the friendliest name available for a first pass is the path's own
 * basename — falls back to the full id for a bare root path like `/` or a
 * value with no separator. */
function workspaceNameFromId(workspaceId: string): string {
  const trimmed = workspaceId.replace(/[/\\]+$/, "");
  const base = trimmed.split(/[/\\]/).pop();
  return base && base.length > 0 ? base : workspaceId;
}

interface DecryptedTitles {
  sessions: Map<string, string>;
  machines: Map<string, string>;
}

const EMPTY_TITLES: DecryptedTitles = { sessions: new Map(), machines: new Map() };

async function decryptSessionTitle(
  bridge: CryptoBridgeClient,
  session: SessionRow,
): Promise<string> {
  try {
    const ok = await bridge.setSessionKey(decodeBase64(session.dek));
    if (!ok) return UNTITLED_SESSION;
    const opened = await bridge.open<{ title?: unknown }>(session.metadata.value);
    if (opened && typeof opened.title === "string" && opened.title.length > 0) {
      return opened.title;
    }
    return UNTITLED_SESSION;
  } catch (err) {
    console.error(`live-source: failed to decrypt session ${session.id}'s metadata`, err);
    return UNTITLED_SESSION;
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
    console.error(`live-source: failed to decrypt machine ${machine.id}'s metadata`, err);
    return UNNAMED_MACHINE;
  }
}

/**
 * Decrypts every session/machine title in `sessions`/`machines`, re-running
 * only for rows this hook hasn't already decrypted at their current
 * `metadata.version` (a version bump — e.g. a title rename — is the only
 * thing that invalidates a cached title; unrelated row changes like a status
 * flip reuse the cached value instead of re-hitting the crypto worker on
 * every sync-engine patch).
 */
function useDecryptedTitles(
  sessions: SessionRow[],
  machines: MachineRow[],
  bridge: CryptoBridgeClient | null,
): DecryptedTitles {
  const [titles, setTitles] = useState<DecryptedTitles>(EMPTY_TITLES);
  const [versions] = useState(() => new Map<string, number>());

  useEffect(() => {
    if (!bridge) return;
    const sessionsToDecrypt = sessions.filter(
      (s) => versions.get(`s:${s.id}`) !== s.metadata.version,
    );
    const machinesToDecrypt = machines.filter(
      (m) => versions.get(`m:${m.id}`) !== m.metadata.version,
    );
    if (sessionsToDecrypt.length === 0 && machinesToDecrypt.length === 0) return;

    let cancelled = false;
    (async () => {
      const nextSessionTitles = new Map<string, string>();
      for (const session of sessionsToDecrypt) {
        if (cancelled) return;
        nextSessionTitles.set(session.id, await decryptSessionTitle(bridge, session));
        versions.set(`s:${session.id}`, session.metadata.version);
      }
      const nextMachineNames = new Map<string, string>();
      for (const machine of machinesToDecrypt) {
        if (cancelled) return;
        nextMachineNames.set(machine.id, await decryptMachineName(bridge, machine));
        versions.set(`m:${machine.id}`, machine.metadata.version);
      }
      if (cancelled) return;
      setTitles((prev) => ({
        sessions: new Map([...prev.sessions, ...nextSessionTitles]),
        machines: new Map([...prev.machines, ...nextMachineNames]),
      }));
    })();

    return () => {
      cancelled = true;
    };
    // `versions` is a stable Map ref (useState initializer) used as a mutable
    // cache — listing it satisfies useExhaustiveDependencies and never
    // triggers a re-run, since the reference itself never changes.
  }, [bridge, sessions, machines, versions]);

  return titles;
}

function isMachineOnline(machine: MachineRow, now: number): boolean {
  return machine.lastSeenAt !== null && now - machine.lastSeenAt <= MACHINE_ONLINE_WINDOW_MS;
}

function buildSnapshot(
  sessionRows: SessionRow[],
  machineRows: MachineRow[],
  titles: DecryptedTitles,
): SessionListSnapshot {
  const now = Date.now();

  const machines: SessionListMachine[] = machineRows.map((m) => ({
    id: m.id,
    name: titles.machines.get(m.id) ?? UNNAMED_MACHINE,
    online: isMachineOnline(m, now),
  }));

  const workspaceIds = new Set<string>();
  for (const s of sessionRows) {
    if (s.workspaceId !== null) workspaceIds.add(s.workspaceId);
  }
  const workspaces: SessionListWorkspace[] = [...workspaceIds].map((id) => ({
    id,
    name: workspaceNameFromId(id),
  }));

  const sessions: SessionListSession[] = sessionRows.map((s) => ({
    id: s.id,
    workspaceId: s.workspaceId,
    machineId: s.machineId,
    title: titles.sessions.get(s.id) ?? UNTITLED_SESSION,
    provider: s.provider,
    status: s.status,
    updatedAt: s.updatedAt,
    // Not derived from a decrypted transcript / live ephemeral stream yet —
    // see this module's doc comment. `deriveSessionStatus` still degrades
    // honestly with these: `active` + no items reads as "idle", never a
    // fabricated "working".
    items: [],
    attention: null,
  }));

  return { workspaces, machines, sessions };
}

/** Real `UseSessionListSnapshot` — swap-in replacement for
 * `useMockSessionListData` (`mock-source.ts`) at the Home screen's call
 * site. Returns an empty snapshot until the account snapshot has loaded and
 * the crypto bridge is ready, same "never crash on absent data" shape the
 * mock's static fixture doesn't need to worry about but a live source does. */
export const useLiveSessionListSnapshot: UseSessionListSnapshot = () => {
  const bridge = useCryptoBridge();
  const query = useSyncSnapshotQuery();

  const sessionRows = query.data?.sessions ?? EMPTY_SESSIONS;
  const machineRows = query.data?.machines ?? EMPTY_MACHINES;
  const titles = useDecryptedTitles(sessionRows, machineRows, bridge);

  return useMemo(
    () => buildSnapshot(sessionRows, machineRows, titles),
    [sessionRows, machineRows, titles],
  );
};
