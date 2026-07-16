/**
 * Sync engine — headerSeq/msgSeq fast-path with gap-invalidation.
 *
 * Ported from Happy's `happy-app/sources/sync/sync.ts` model (a singleton
 * combining `apiSocket` + `InvalidateSync`), split per **⚠ DELTA D1/D2**
 * (falcon-system-design.md §4.3, §9.1; plan.md §8.1, §16 line 705): reads
 * arrive over the WS `update` stream, but *writes* go through TanStack Query
 * mutations against the HTTP endpoints (§4.3) — this module only ever reads
 * from the socket and reconciles the Query cache, it never emits writes.
 *
 * Two-level gap detection (design §4.3 "Ordering contract"):
 *  - **Header stream** (account-level `seq`, absent only on `message-new`):
 *    structural changes — session/machine/unmanaged create-update-delete,
 *    metadata/state version bumps. Fast path applies `seq === lastHeaderSeq
 *    + 1` directly to the `['sync']` Query cache; any gap invalidates it, so
 *    whatever owns the matching `useQuery` refetches `GET /v1/sync?since=`.
 *  - **Message stream** (per-session `msgSeq`): high-rate transcript events,
 *    tracked independently per session so parallel chatty sessions never
 *    contend on one counter. Only tracked for sessions whose message pages
 *    are actually cached (i.e. currently open) — a `message-new` for a
 *    session nobody has opened is simply ignored; opening it later fetches
 *    fresh via `GET /v1/sessions/:id/messages`.
 *
 * On WS reconnect: invalidate *every* query (design §9.1: "reconnect/focus
 * ⇒ invalidate all queries") rather than trying to resume a gap silently —
 * Happy's model, ported verbatim.
 *
 * Ownership split: this module never fetches anything itself. It reconciles
 * its two in-memory seq trackers with whatever the Query cache actually
 * holds (via a `QueryCache` subscription) so it stays correct no matter
 * *why* the cache changed — initial mount, an invalidate-triggered refetch,
 * or a manual `setQueryData` elsewhere — and it only ever calls
 * `setQueryData`/`invalidateQueries`, never `fetchQuery`.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { MachineRow, SessionRow, UnmanagedSessionRow, Update, UpdateBody } from "@falcon/wire";
import { isSyncQueryKey, messagesQueryKey, messagesSessionIdFromKey, syncQueryKey } from "./queryKeys.js";
import type { MessageItem, MessagesQueryData, SyncSnapshot } from "./types.js";

/**
 * The narrow slice of `apiSocket` (see `../sync/apiSocket.ts` once §1.6's
 * `apiSocket` bullet lands) this engine needs: the `update` stream and the
 * `reconnect` signal. Declared locally — rather than importing that module
 * directly — so the engine is buildable/testable in isolation against the
 * wire contract alone, per plan.md 1.6's own note that the sync engine "can
 * be built and verified in isolation now against the wire contract." A real
 * `ApiSocket` satisfies this structurally; no adapter needed at call sites.
 */
export interface SyncSocketSource {
  on(event: "update", handler: (update: Update) => void): () => void;
  on(event: "reconnect", handler: () => void): () => void;
}

export interface SyncEngine {
  /** Detach every listener this engine registered (on the socket and on the
   * Query cache). Call on logout/teardown; safe to call more than once. */
  dispose(): void;
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
}

function patchSession(
  session: SessionRow,
  body: Extract<UpdateBody, { t: "session-update" }>,
): SessionRow {
  return {
    ...session,
    ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    ...(body.agentState !== undefined ? { agentState: body.agentState } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
  };
}

export function createSyncEngine(queryClient: QueryClient, socket: SyncSocketSource): SyncEngine {
  /** `null` until a `['sync']` fetch (initial load, gap-triggered refetch,
   * or reconnect-triggered refetch) has actually settled into the cache —
   * with no baseline there is no way to know if an incoming `seq` is
   * contiguous, so every structural update is treated as a gap until then. */
  let lastHeaderSeq: number | null = null;
  /** Per-session tracker, populated only for sessions with a cached message
   * page (see the cache subscription below) — never grows unbounded across
   * sessions the user hasn't opened. */
  const lastMsgSeq = new Map<string, number>();

  // Seed both trackers from whatever is *already* in the cache at
  // construction time (e.g. an initial `GET /v1/sync` / message-page fetch
  // that resolved before this engine was created) — the subscription below
  // only observes changes from this point forward, so without this an
  // engine created after the first fetch would treat every subsequent
  // update as a gap forever.
  const initialSync = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
  if (initialSync) lastHeaderSeq = initialSync.headerSeq;
  for (const [key, data] of queryClient.getQueriesData<MessagesQueryData>({ queryKey: ["messages"] })) {
    const sessionId = messagesSessionIdFromKey(key);
    const newest = data?.pages[0]?.messages[0]?.seq;
    if (sessionId !== null && newest !== undefined) lastMsgSeq.set(sessionId, newest);
  }

  const cacheSub = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const { queryKey, state } = event.query;
    if (isSyncQueryKey(queryKey)) {
      const data = state.data as SyncSnapshot | undefined;
      if (data) lastHeaderSeq = data.headerSeq;
      return;
    }
    const sessionId = messagesSessionIdFromKey(queryKey);
    if (sessionId === null) return;
    const data = state.data as MessagesQueryData | undefined;
    const newest = data?.pages[0]?.messages[0]?.seq;
    if (newest !== undefined) lastMsgSeq.set(sessionId, newest);
  });

  function applyStructural(body: UpdateBody, seq: number): void {
    queryClient.setQueryData<SyncSnapshot>(syncQueryKey, (old) => {
      if (!old) return old; // no cached snapshot to patch — a later mount fetches fresh
      const next: SyncSnapshot = { ...old, headerSeq: seq };
      switch (body.t) {
        case "session-new":
          return { ...next, sessions: upsertById(next.sessions, body.session) };
        case "session-update":
          return {
            ...next,
            sessions: next.sessions.map((s) => (s.id === body.id ? patchSession(s, body) : s)),
          };
        case "session-delete":
          return { ...next, sessions: next.sessions.filter((s) => s.id !== body.id) };
        case "machine-new":
        case "machine-update":
          return { ...next, machines: upsertById<MachineRow>(next.machines, body.machine) };
        case "unmanaged-new":
        case "unmanaged-update":
          return {
            ...next,
            unmanagedSessions: upsertById<UnmanagedSessionRow>(next.unmanagedSessions, body.item),
          };
        case "account-update":
          // No `settings` field on the sync snapshot yet (server's
          // `SyncResponseSchema` doesn't carry one) — nothing to patch.
          return next;
        case "message-new":
          // Unreachable: handleUpdate routes `message-new` to the message
          // fast-path before this function is ever called. Handled here only
          // for switch exhaustiveness over `UpdateBody`.
          return next;
      }
    });
  }

  function applyMessageFastPath(
    sessionId: string,
    msgSeq: number,
    localId: string | undefined,
    content: MessageItem["content"],
    ts: number,
  ): void {
    const known = lastMsgSeq.get(sessionId);
    if (known === undefined) return; // session isn't open/cached — ignore, a later open fetches fresh
    if (msgSeq <= known) return; // duplicate/stale redelivery (HTTP-write echo racing the WS fan-out)
    if (msgSeq !== known + 1) {
      queryClient.invalidateQueries({ queryKey: messagesQueryKey(sessionId) });
      return;
    }
    queryClient.setQueryData<MessagesQueryData>(messagesQueryKey(sessionId), (old) => {
      if (!old || old.pages.length === 0) return old;
      const [first, ...rest] = old.pages;
      if (!first) return old;
      const item: MessageItem = { seq: msgSeq, localId: localId ?? null, content, createdAt: ts };
      return { ...old, pages: [{ ...first, messages: [item, ...first.messages] }, ...rest] };
    });
    lastMsgSeq.set(sessionId, msgSeq);
  }

  function handleUpdate(update: Update): void {
    if (update.body.t === "message-new") {
      const { sessionId, msgSeq, localId, content } = update.body;
      applyMessageFastPath(sessionId, msgSeq, localId, content, update.ts);
      return;
    }
    const seq = update.seq;
    if (seq !== undefined && lastHeaderSeq !== null && seq === lastHeaderSeq + 1) {
      applyStructural(update.body, seq);
      lastHeaderSeq = seq;
    } else {
      // No baseline yet, a genuine gap, an out-of-order regression, or a
      // malformed update missing `seq` (only `message-new` may omit it) —
      // always safe to fall back to a full resync rather than guess (design
      // principle: no silent failures).
      queryClient.invalidateQueries({ queryKey: syncQueryKey });
    }
  }

  function handleReconnect(): void {
    // Happy's model, ported verbatim (design §9.1, plan.md §8.1): never try
    // to resume a gap silently across a reconnect. Invalidate everything —
    // the header snapshot and every open session's message pages — and let
    // each active query refetch.
    queryClient.invalidateQueries();
  }

  const offUpdate = socket.on("update", handleUpdate);
  const offReconnect = socket.on("reconnect", handleReconnect);

  return {
    dispose(): void {
      offUpdate();
      offReconnect();
      cacheSub();
    },
  };
}
