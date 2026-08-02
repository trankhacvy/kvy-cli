"use client";

import { decodeBase64 } from "@kvy/crypto/web";
import type { Ephemeral, MachineRow, SessionRow } from "@kvy/wire";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { resolveSelectedMachine } from "@/components/machine-switcher-state";
import type { CryptoBridgeClient } from "@/crypto";
import type { EphemeralSource } from "@/features/session-control";
import { getSessionMessages } from "@/lib/api";
import { getToken } from "@/lib/session";
import { useDedicatedCryptoBridge } from "@/lib/use-crypto-bridge";
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
import type { DecryptedTitles } from "./use-decrypted-titles";
import {
  deriveMachineOnline,
  deriveMachineStatus,
  type MachinePresence,
  useMachinePresence,
} from "./use-machine-presence";
import { useWorkspaceIndexContext } from "./workspace-index-context";

/**
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
 * carry no plaintext title. `useDecryptedTitles` below unwraps each row's
 * DEK (`bridge.setSessionKey`) and opens its metadata box
 * (`bridge.open`) one row at a time, since a crypto-bridge worker only ever
 * holds one *active* session key at once (`crypto/client.ts`'s
 * `setSessionKey` doc comment) — sequential `await`s, not a parallel
 * `Promise.all`, are required for correctness here, not just style. Failure
 * to decrypt a given row (bad/foreign DEK, corrupt box) never throws or
 * drops the row — it falls back to an honest placeholder, per this
 * codebase's "no silent failures, no silent data loss" design principle
 * (`@kvy/crypto`'s `open()` doc comment).
 *
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
    // `null` (not `[]`) until this session's own message page has actually
    // decrypted this pass — `items.get` returns `undefined` for "no entry
    // yet", coerced here to the explicit `null` `SessionListSession.items`
    // documents. `deriveSessionStatus` treats that as "unknown" (degrades to
    // "idle", never a fabricated "working" OR a fabricated "ready" — the
    // latter was a real regression this exact line caused once "ready" was
    // introduced for known-issues.md #9, since a `[]` fallback here made
    // every session flash "ready" on load regardless of real history).
    items: items.get(s.id) ?? null,
    attention: attention.get(s.id) ?? null,
  }));

  return { workspaces, machines, sessions };
}

/** Real `UseSessionListSnapshot` — the Home screen's default data source.
 * Returns an empty snapshot until the account snapshot has loaded and the
 * crypto bridge is ready: a live source has to tolerate "no data yet" at
 * every layer rather than assume a fixture's always-present rows. */
export const useLiveSessionListSnapshot: UseSessionListSnapshot = () => {
  const { sessionRows, machineRows, titles, isLoading, selectedMachineId } =
    useWorkspaceIndexContext();
  // Its own worker, deliberately not shared with the context's titles bridge
  // — see the module doc comment: two independent effects racing
  // `setSessionKey` calls against one shared worker can decrypt under the
  // wrong key.
  const itemsBridge = useDedicatedCryptoBridge();
  const presence = useMachinePresence();
  const attention = useLiveAttention();

  const sessionIds = useMemo(() => sessionRows.map((s) => s.id), [sessionRows]);
  const pageResults = useSessionMessagePages(sessionIds);
  const items = useDecryptedItems(sessionRows, pageResults, itemsBridge);

  return useMemo(() => {
    const snapshot = buildSnapshot(sessionRows, machineRows, titles, presence, items, attention);
    // Scoped to the sidebar `MachineSwitcher`'s current pick (same
    // `resolveSelectedMachine` fallback it displays, so what's highlighted
    // there always matches what's listed here) — `machines`/`workspaces`
    // stay the full account-wide lists (`hasMachines`, `NewWorkspaceTrigger`
    // need every machine, not just the selected one); only `sessions` is
    // scoped down, and `group.ts` only ever forms a group for a workspace
    // that still has a session left after this filter.
    const currentMachine = resolveSelectedMachine(snapshot.machines, selectedMachineId);
    const sessions = currentMachine
      ? snapshot.sessions.filter((s) => s.machineId === currentMachine.id)
      : snapshot.sessions;
    return { ...snapshot, sessions, isLoading };
  }, [sessionRows, machineRows, titles, presence, items, attention, isLoading, selectedMachineId]);
};
