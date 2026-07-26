"use client";

import { decodeBase64 } from "@falcon/crypto/web";
import type { Ephemeral, MachineRow, SessionRow } from "@falcon/wire";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { CryptoBridgeClient } from "@/crypto";
import type { EphemeralSource } from "@/features/session-control";
import { getSessionMessages } from "@/lib/api";
import { getToken } from "@/lib/session";
import { useDedicatedCryptoBridge } from "@/lib/use-crypto-bridge";
import { useSyncSnapshotQuery } from "@/lib/use-sync-snapshot";
import { apiSocket, decryptMessageBatches, type MessagesQueryData, messagesQueryKey } from "@/sync";
import { type RenderItem, reduceEnvelopes } from "@/sync/reducer";
import type {
  AttentionKind,
  SessionListMachine,
  SessionListSession,
  SessionListSnapshot,
  SessionListWorkspace,
  UseSessionListSnapshot,
} from "./types";
import {
  deriveMachineOnline,
  deriveMachineStatus,
  type MachinePresence,
  useMachinePresence,
} from "./use-machine-presence";

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
 * Status inputs (plan.md §16 W3.6 "Home screen real status dots +
 * presence"): `machineOnline` prefers the live `machine-presence` ephemeral
 * (`use-machine-presence.ts`, shared with `features/unmanaged-sessions`),
 * falling back to the `lastSeenAt` heuristic until this machine's first
 * live event arrives. Per-session `items` come from that session's *most
 * recent* page of `GET /v1/sessions/:id/messages` (`useSessionMessagePages`
 * below, one `useQueries` entry per session — deliberately the real
 * `messagesQueryKey` so `sync/engine.ts`'s per-session message fast-path
 * keeps a rendered row's page current across `message-new` events, exactly
 * like the Timeline's own `useLiveRenderItems`), decrypted sequentially
 * against `useDecryptedItems`'s *own* `useDedicatedCryptoBridge()` instance —
 * a separate worker from `useDecryptedTitles`'s, not shared with it. A
 * crypto-bridge worker only ever holds one active session key at once
 * (`setSessionKey` doc comment), but that constraint is *within* a single
 * worker; `useDecryptedTitles` and `useDecryptedItems` are two independent
 * React effects with no mutual exclusion between them, so a single shared
 * bridge could have one effect's `setSessionKey` land between the other's
 * `setSessionKey`+`open`, decrypting under the wrong key. Giving each hook
 * its own worker via `useDedicatedCryptoBridge()` (`lib/use-crypto-bridge.ts` —
 * plain `useCryptoBridge()` is a refcounted app-wide singleton and does NOT
 * give isolation on its own, see that hook's doc comment) sidesteps the race
 * entirely instead of building a cross-hook decrypt queue. `attention` comes
 * from the live `attention` ephemeral
 * (`useLiveAttention`) — the wire's `SessionEvent` union has no "agent asked
 * a question" variant, so this is the only source for it, mirroring
 * `features/session-control/use-session-ephemerals.ts`'s per-session
 * pattern but fanned across every row this hook is given rather than one
 * open session at a time.
 */

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

/** A session's decrypted title plus its Pin flag (docs/features/
 * session-lifecycle-actions.md Phase 4) — both live in the same encrypted
 * metadata blob, so one `open()` call resolves both at once. */
interface DecryptedSessionMeta {
  title: string;
  pinned: boolean;
}

interface DecryptedTitles {
  sessions: Map<string, DecryptedSessionMeta>;
  machines: Map<string, string>;
}

const EMPTY_TITLES: DecryptedTitles = { sessions: new Map(), machines: new Map() };

async function decryptSessionMeta(
  bridge: CryptoBridgeClient,
  session: SessionRow,
): Promise<DecryptedSessionMeta> {
  try {
    const ok = await bridge.setSessionKey(decodeBase64(session.dek));
    if (!ok) return { title: UNTITLED_SESSION, pinned: false };
    const opened = await bridge.open<{ title?: unknown; pinned?: unknown }>(session.metadata.value);
    const title =
      opened && typeof opened.title === "string" && opened.title.length > 0
        ? opened.title
        : UNTITLED_SESSION;
    const pinned = opened?.pinned === true;
    return { title, pinned };
  } catch (err) {
    console.error(`live-source: failed to decrypt session ${session.id}'s metadata`, err);
    return { title: UNTITLED_SESSION, pinned: false };
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
      const nextSessionTitles = new Map<string, DecryptedSessionMeta>();
      for (const session of sessionsToDecrypt) {
        if (cancelled) return;
        nextSessionTitles.set(session.id, await decryptSessionMeta(bridge, session));
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

/** The newest cached message's `seq` for a fetched page, or `0` for a
 * genuinely empty (but fetched) page — mirrors `sync/engine.ts`'s own
 * `msgSeqBaseline`, used here as the cheap "has this session's page actually
 * changed" cache key so `useDecryptedItems` only re-decrypts sessions whose
 * fetched data moved (a fresh `message-new` fast-patch, or the initial
 * fetch), not every session on every render. */
export function newestSeq(data: MessagesQueryData | undefined): number | undefined {
  return data?.pages[0]?.messages[0]?.seq ?? (data ? 0 : undefined);
}

/**
 * One `useQueries` entry per session, each at the *real* `messagesQueryKey`
 * (`@/sync`) fetching only the newest page (no `before` cursor) — the same
 * cache key `features/session-control/use-live-render-items.ts`'s
 * `useInfiniteQuery` reads/writes for the Timeline, and the one
 * `sync/engine.ts`'s per-session message fast-path patches on every
 * `message-new` WS event. Sharing the key (not just the shape) is what keeps
 * a Home-screen row's status live without a second sync mechanism: opening
 * that session's Timeline later reuses this exact cached page instead of
 * re-fetching, and a `message-new` for a row currently rendered on Home
 * keeps it patched even before the Timeline is ever opened.
 *
 * `useQueries` (rather than calling a hook once per session inside a
 * `.map()`) is what makes this safe against a session list whose length
 * changes across renders — TanStack Query's own array-of-queries hook is
 * built for exactly that; a hand-rolled loop over `useQuery` calls would not
 * satisfy the Rules of Hooks here.
 */
function useSessionMessagePages(sessionIds: string[]) {
  const signedIn = getToken() !== null;
  return useQueries({
    queries: sessionIds.map((sessionId) => ({
      queryKey: messagesQueryKey(sessionId),
      queryFn: async (): Promise<MessagesQueryData> => {
        const token = getToken();
        if (!token) throw new Error("Not signed in");
        const page = await getSessionMessages(token, sessionId);
        return { pages: [page], pageParams: [undefined] };
      },
      enabled: signedIn,
      // Kept current by the sync engine's per-session fast-path, not
      // polling — same rationale as `useSyncSnapshotQuery`'s `staleTime`.
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
}

/**
 * Decrypts each session's fetched message page into `RenderItem[]`
 * (`reduceEnvelopes`), one session at a time against `bridge` — this hook's
 * *own* `useDedicatedCryptoBridge()` instance, deliberately not shared with
 * `useDecryptedTitles`'s bridge (see the module doc comment above: a
 * crypto-bridge worker only ever holds one active session key at once, and
 * two independent effects racing `setSessionKey` calls against the same
 * worker can decrypt under the wrong key). Within this hook, the loop still
 * `await`s each session's `setSessionKey` + decrypt before moving to the
 * next rather than firing them in parallel, since *this* loop's own calls
 * do share one worker. Only re-decrypts a session whose fetched page's
 * newest `seq` has actually changed since the last pass (`newestSeq`), so a
 * sync-engine fast-patch to one session's cache doesn't re-run the crypto
 * worker for every other row.
 */
function useDecryptedItems(
  sessions: SessionRow[],
  pageResults: Array<{ data: MessagesQueryData | undefined }>,
  bridge: CryptoBridgeClient | null,
): Map<string, RenderItem[]> {
  const [items, setItems] = useState<Map<string, RenderItem[]>>(new Map());
  const [seqCache] = useState(() => new Map<string, number>());

  useEffect(() => {
    if (!bridge) return;
    const toDecrypt: Array<{ session: SessionRow; data: MessagesQueryData }> = [];
    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      const data = pageResults[i]?.data;
      if (!session || !data) continue;
      const seq = newestSeq(data);
      if (seq === undefined || seqCache.get(session.id) === seq) continue;
      toDecrypt.push({ session, data });
    }
    if (toDecrypt.length === 0) return;

    let cancelled = false;
    (async () => {
      const next = new Map<string, RenderItem[]>();
      for (const { session, data } of toDecrypt) {
        if (cancelled) return;
        try {
          const ok = await bridge.setSessionKey(decodeBase64(session.dek));
          const envelopes = ok ? await decryptMessageBatches(data.pages, bridge) : [];
          next.set(session.id, reduceEnvelopes(envelopes));
        } catch (err) {
          console.error(`live-source: failed to decrypt session ${session.id}'s messages`, err);
          next.set(session.id, []);
        }
        const seq = newestSeq(data);
        if (seq !== undefined) seqCache.set(session.id, seq);
      }
      if (cancelled) return;
      setItems((prev) => new Map([...prev, ...next]));
    })();

    return () => {
      cancelled = true;
    };
    // `seqCache` is a stable Map ref (useState initializer) used as a
    // mutable cache — listing it satisfies useExhaustiveDependencies and
    // never triggers a re-run, since the reference itself never changes.
  }, [bridge, sessions, pageResults, seqCache]);

  return items;
}

/** Live `attention` ephemeral, fanned across every session this hook is
 * given (falcon-system-design.md §4.3) — mirrors
 * `features/session-control/use-session-ephemerals.ts`'s per-session
 * pattern, but as one shared subscription for however many rows are
 * currently rendered rather than one hook instance per open session. */
function useLiveAttention(source: EphemeralSource = apiSocket): Map<string, AttentionKind> {
  const [attention, setAttention] = useState<Map<string, AttentionKind>>(new Map());

  // biome-ignore lint/correctness/useExhaustiveDependencies: `source` is a stable singleton by default (apiSocket) or a test double the caller controls — subscribe once for the component's lifetime.
  useEffect(() => {
    return source.on("ephemeral", (event: Ephemeral) => {
      if (event.t !== "attention") return;
      setAttention((prev) => {
        if (prev.get(event.sessionId) === event.kind) return prev;
        const next = new Map(prev);
        next.set(event.sessionId, event.kind);
        return next;
      });
    });
  }, []);

  return attention;
}

/** Exported for `live-source.test.ts` — assembles the final `SessionListSnapshot`
 * from already-resolved inputs (no async/effect involved), so status-derivation
 * fixtures can exercise the real assembly logic deterministically instead of
 * hand-building a `SessionListSnapshot` and skipping it entirely. */
export function buildSnapshot(
  sessionRows: SessionRow[],
  machineRows: MachineRow[],
  titles: DecryptedTitles,
  presence: Map<string, MachinePresence>,
  items: Map<string, RenderItem[]>,
  attention: Map<string, AttentionKind>,
): SessionListSnapshot {
  const now = Date.now();

  const machines: SessionListMachine[] = machineRows.map((m) => ({
    id: m.id,
    // `null` = not decrypted yet (see `SessionListMachine.name`'s doc
    // comment) — the map only ever has an entry once `decryptMachineName`
    // has genuinely resolved (success or the honest `UNNAMED_MACHINE`
    // fallback), never as a stand-in for "haven't gotten to it yet".
    name: titles.machines.get(m.id) ?? null,
    online: deriveMachineOnline(m, presence, now),
    // AH8 "machine-status-reauth": the richer 3-way status the badge
    // renders — see `SessionListMachine.status`'s own doc comment for why
    // this lives alongside `online` rather than replacing it.
    status: deriveMachineStatus(m, presence, now),
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
    // `null` = not decrypted yet (see `SessionListSession.title`'s doc
    // comment) — the map only ever has an entry once `decryptSessionMeta`
    // has genuinely resolved (success or the honest `UNTITLED_SESSION`
    // fallback), never as a stand-in for "haven't gotten to it yet".
    title: titles.sessions.get(s.id)?.title ?? null,
    pinned: titles.sessions.get(s.id)?.pinned ?? false,
    provider: s.provider,
    status: s.status,
    updatedAt: s.updatedAt,
    // Empty/`null` until this session's own message page has decrypted /
    // an ephemeral has arrived — `deriveSessionStatus` still degrades
    // honestly with these: `active` + no items yet reads as "idle", never a
    // fabricated "working".
    items: items.get(s.id) ?? [],
    attention: attention.get(s.id) ?? null,
  }));

  return { workspaces, machines, sessions };
}

/** Real `UseSessionListSnapshot` — the Home screen's default data source.
 * Returns an empty snapshot until the account snapshot has loaded and the
 * crypto bridge is ready: a live source has to tolerate "no data yet" at
 * every layer rather than assume a fixture's always-present rows. */
export const useLiveSessionListSnapshot: UseSessionListSnapshot = () => {
  const titlesBridge = useDedicatedCryptoBridge();
  // Its own worker, deliberately not shared with `titlesBridge` — see the
  // module doc comment: two independent effects racing `setSessionKey`
  // calls against one shared worker can decrypt under the wrong key.
  const itemsBridge = useDedicatedCryptoBridge();
  const query = useSyncSnapshotQuery();

  const sessionRows = query.data?.sessions ?? EMPTY_SESSIONS;
  const machineRows = query.data?.machines ?? EMPTY_MACHINES;
  const titles = useDecryptedTitles(sessionRows, machineRows, titlesBridge);
  const presence = useMachinePresence();
  const attention = useLiveAttention();

  const sessionIds = useMemo(() => sessionRows.map((s) => s.id), [sessionRows]);
  const pageResults = useSessionMessagePages(sessionIds);
  const items = useDecryptedItems(sessionRows, pageResults, itemsBridge);

  return useMemo(
    () => ({
      ...buildSnapshot(sessionRows, machineRows, titles, presence, items, attention),
      isLoading: query.isLoading,
    }),
    [sessionRows, machineRows, titles, presence, items, attention, query.isLoading],
  );
};
