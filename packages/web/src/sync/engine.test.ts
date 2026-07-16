import type { EncryptedBox, SessionRow, Update } from "@falcon/wire";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSyncSocket } from "./__tests__/engineFakes.js";
import { createSyncEngine } from "./engine.js";
import { messagesQueryKey, syncQueryKey } from "./queryKeys.js";
import type { MessagesQueryData, SyncSnapshot } from "./types.js";

function box(c: string): EncryptedBox {
  return { t: "enc", v: 1, c };
}

function makeSession(id: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    accountId: "acc-1",
    workspaceId: null,
    machineId: null,
    tag: id,
    provider: "claude-code",
    executionTarget: "local",
    status: "active",
    metadata: { value: box("meta-v1"), version: 1 },
    agentState: null,
    dek: "dek-opaque",
    msgSeq: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    headerSeq: 5,
    sessions: [makeSession("sess-1")],
    machines: [],
    unmanagedSessions: [],
    ...overrides,
  };
}

function makeMessagesData(overrides: Partial<MessagesQueryData> = {}): MessagesQueryData {
  return {
    pages: [
      {
        messages: [{ seq: 3, localId: "l-3", content: box("m3"), createdAt: 3000 }],
        nextBefore: 3,
      },
    ],
    pageParams: [undefined],
    ...overrides,
  };
}

describe("createSyncEngine", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
    });
  });

  describe("structural (header) stream", () => {
    it("applies a contiguous session-new directly, bumping headerSeq, without invalidating", () => {
      queryClient.setQueryData(syncQueryKey, makeSnapshot({ headerSeq: 5 }));
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      let invalidated = 0;
      queryClient.getQueryCache().subscribe((e) => {
        if (e.type === "updated" && e.query.state.isInvalidated) invalidated += 1;
      });

      const update: Update = {
        seq: 6,
        ts: 2000,
        body: { t: "session-new", session: makeSession("sess-2") },
      };
      emitUpdate(update);

      const data = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
      expect(data?.headerSeq).toBe(6);
      expect(data?.sessions.map((s) => s.id)).toEqual(["sess-1", "sess-2"]);
      expect(invalidated).toBe(0);
    });

    it("invalidates ['sync'] on a header gap instead of guessing", () => {
      queryClient.setQueryData(syncQueryKey, makeSnapshot({ headerSeq: 5 }));
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      emitUpdate({
        seq: 8, // gap: expected 6
        ts: 2000,
        body: { t: "session-delete", id: "sess-1" },
      });

      expect(queryClient.getQueryState(syncQueryKey)?.isInvalidated).toBe(true);
      // Not applied — the cached snapshot is untouched by the gapped update.
      const data = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
      expect(data?.headerSeq).toBe(5);
      expect(data?.sessions.map((s) => s.id)).toEqual(["sess-1"]);
    });

    it("invalidates when no baseline headerSeq has been observed yet", () => {
      // No setQueryData(['sync'], ...) happened — engine never saw a snapshot.
      // (No query object exists yet either, so there's nothing for
      // `invalidateQueries` to mark invalid — assert the call itself.)
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

      emitUpdate({ seq: 1, ts: 1, body: { t: "session-delete", id: "sess-1" } });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: syncQueryKey });
    });

    it("invalidates a structural update with a missing seq rather than applying it", () => {
      queryClient.setQueryData(syncQueryKey, makeSnapshot({ headerSeq: 5 }));
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      // `seq` is legitimately optional on the wire type (only `message-new`
      // is *supposed* to omit it) — the engine must treat any structural
      // update missing it as a gap, not crash trying to do arithmetic on it.
      emitUpdate({ ts: 1, body: { t: "session-delete", id: "sess-1" } });

      expect(queryClient.getQueryState(syncQueryKey)?.isInvalidated).toBe(true);
    });

    it("patches only the given fields on session-update, leaving others untouched", () => {
      queryClient.setQueryData(
        syncQueryKey,
        makeSnapshot({ headerSeq: 5, sessions: [makeSession("sess-1", { status: "active" })] }),
      );
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      emitUpdate({
        seq: 6,
        ts: 2000,
        body: { t: "session-update", id: "sess-1", status: "archived" },
      });

      const data = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
      const session = data?.sessions.find((s) => s.id === "sess-1");
      expect(session?.status).toBe("archived");
      expect(session?.tag).toBe("sess-1"); // untouched field survives
    });

    it("patches metadata and agentState on session-update, leaving status untouched", () => {
      queryClient.setQueryData(
        syncQueryKey,
        makeSnapshot({ headerSeq: 5, sessions: [makeSession("sess-1", { status: "active" })] }),
      );
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      emitUpdate({
        seq: 6,
        ts: 2000,
        body: {
          t: "session-update",
          id: "sess-1",
          metadata: { value: box("meta-v2"), version: 2 },
          agentState: { value: box("state-v1"), version: 1 },
        },
      });

      const data = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
      const session = data?.sessions.find((s) => s.id === "sess-1");
      expect(session?.metadata).toEqual({ value: box("meta-v2"), version: 2 });
      expect(session?.agentState).toEqual({ value: box("state-v1"), version: 1 });
      expect(session?.status).toBe("active"); // untouched field survives
    });

    it("upserts machines and unmanaged sessions by id", () => {
      queryClient.setQueryData(syncQueryKey, makeSnapshot({ headerSeq: 5, machines: [] }));
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      emitUpdate({
        seq: 6,
        ts: 2000,
        body: {
          t: "machine-new",
          machine: {
            id: "mach-1",
            accountId: "acc-1",
            metadata: { value: box("m"), version: 1 },
            daemonState: null,
            dek: "dek",
            lastSeenAt: null,
          },
        },
      });

      expect(
        queryClient.getQueryData<SyncSnapshot>(syncQueryKey)?.machines.map((m) => m.id),
      ).toEqual(["mach-1"]);
    });

    it("upserts a machine-update onto an existing machine by id, not appending a duplicate", () => {
      queryClient.setQueryData(
        syncQueryKey,
        makeSnapshot({
          headerSeq: 5,
          machines: [
            {
              id: "mach-1",
              accountId: "acc-1",
              metadata: { value: box("m-old"), version: 1 },
              daemonState: null,
              dek: "dek",
              lastSeenAt: null,
            },
          ],
        }),
      );
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      emitUpdate({
        seq: 6,
        ts: 2000,
        body: {
          t: "machine-update",
          machine: {
            id: "mach-1",
            accountId: "acc-1",
            metadata: { value: box("m-new"), version: 2 },
            daemonState: null,
            dek: "dek",
            lastSeenAt: 3000,
          },
        },
      });

      const data = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
      expect(data?.machines).toHaveLength(1);
      expect(data?.machines[0]?.lastSeenAt).toBe(3000);
    });

    it("upserts unmanaged-new and unmanaged-update items by id", () => {
      queryClient.setQueryData(syncQueryKey, makeSnapshot({ headerSeq: 5, unmanagedSessions: [] }));
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      const item = {
        id: "un-1",
        accountId: "acc-1",
        machineId: "mach-1",
        workspaceId: "ws-1",
        providerRef: "ref-1",
        summary: box("s1"),
        dek: "dek",
        updatedAt: 1000,
      };
      emitUpdate({ seq: 6, ts: 2000, body: { t: "unmanaged-new", item } });
      expect(
        queryClient.getQueryData<SyncSnapshot>(syncQueryKey)?.unmanagedSessions.map((u) => u.id),
      ).toEqual(["un-1"]);

      emitUpdate({
        seq: 7,
        ts: 3000,
        body: { t: "unmanaged-update", item: { ...item, summary: box("s2") } },
      });
      const data = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
      expect(data?.unmanagedSessions).toHaveLength(1);
      expect(data?.unmanagedSessions[0]?.summary).toEqual(box("s2"));
    });

    it("removes the session on a contiguous session-delete fast-path apply", () => {
      queryClient.setQueryData(
        syncQueryKey,
        makeSnapshot({ headerSeq: 5, sessions: [makeSession("sess-1"), makeSession("sess-2")] }),
      );
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      emitUpdate({ seq: 6, ts: 2000, body: { t: "session-delete", id: "sess-1" } });

      const data = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
      expect(data?.headerSeq).toBe(6);
      expect(data?.sessions.map((s) => s.id)).toEqual(["sess-2"]);
    });

    it("is a documented no-op for account-update: bumps headerSeq without touching cached fields", () => {
      queryClient.setQueryData(syncQueryKey, makeSnapshot({ headerSeq: 5 }));
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      emitUpdate({ seq: 6, ts: 2000, body: { t: "account-update", settings: box("settings") } });

      const data = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
      expect(data?.headerSeq).toBe(6);
      expect(data?.sessions.map((s) => s.id)).toEqual(["sess-1"]);
    });

    it("invalidates rather than fast-path-applying an exact-duplicate headerSeq redelivery", () => {
      queryClient.setQueryData(syncQueryKey, makeSnapshot({ headerSeq: 5 }));
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      // seq === lastHeaderSeq (not +1) — a redelivered/duplicate update, not a gap forward.
      emitUpdate({ seq: 5, ts: 2000, body: { t: "session-delete", id: "sess-1" } });

      expect(queryClient.getQueryState(syncQueryKey)?.isInvalidated).toBe(true);
      const data = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
      expect(data?.headerSeq).toBe(5);
      expect(data?.sessions.map((s) => s.id)).toEqual(["sess-1"]); // not deleted
    });
  });

  describe("message (per-session) stream", () => {
    it("prepends a contiguous message-new to the newest cached page and advances the tracker", () => {
      queryClient.setQueryData(messagesQueryKey("sess-1"), makeMessagesData());
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      emitUpdate({
        ts: 4000,
        body: {
          t: "message-new",
          sessionId: "sess-1",
          msgSeq: 4,
          localId: "l-4",
          content: box("m4"),
        },
      });

      const data = queryClient.getQueryData<MessagesQueryData>(messagesQueryKey("sess-1"));
      expect(data?.pages[0]?.messages.map((m) => m.seq)).toEqual([4, 3]);
      expect(data?.pages[0]?.messages[0]).toEqual({
        seq: 4,
        localId: "l-4",
        content: box("m4"),
        createdAt: 4000,
      });

      // A follow-up contiguous message keeps applying without a gap.
      emitUpdate({
        ts: 5000,
        body: { t: "message-new", sessionId: "sess-1", msgSeq: 5, content: box("m5") },
      });
      const after = queryClient.getQueryData<MessagesQueryData>(messagesQueryKey("sess-1"));
      expect(after?.pages[0]?.messages.map((m) => m.seq)).toEqual([5, 4, 3]);
    });

    it("invalidates only that session's message query on a msgSeq gap", () => {
      queryClient.setQueryData(messagesQueryKey("sess-1"), makeMessagesData());
      queryClient.setQueryData(syncQueryKey, makeSnapshot({ headerSeq: 5 }));
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      emitUpdate({
        ts: 4000,
        body: { t: "message-new", sessionId: "sess-1", msgSeq: 10, content: box("m10") }, // gap: expected 4
      });

      expect(queryClient.getQueryState(messagesQueryKey("sess-1"))?.isInvalidated).toBe(true);
      // The unrelated ['sync'] query is untouched — gap detection is per-session.
      expect(queryClient.getQueryState(syncQueryKey)?.isInvalidated).toBe(false);
      // Cache contents unchanged (no half-applied splice).
      const data = queryClient.getQueryData<MessagesQueryData>(messagesQueryKey("sess-1"));
      expect(data?.pages[0]?.messages.map((m) => m.seq)).toEqual([3]);
    });

    it("ignores a duplicate/stale message-new (msgSeq <= known) without invalidating", () => {
      queryClient.setQueryData(messagesQueryKey("sess-1"), makeMessagesData()); // known = 3
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      emitUpdate({
        ts: 4000,
        body: { t: "message-new", sessionId: "sess-1", msgSeq: 3, content: box("dup") },
      });

      expect(queryClient.getQueryState(messagesQueryKey("sess-1"))?.isInvalidated).toBe(false);
      const data = queryClient.getQueryData<MessagesQueryData>(messagesQueryKey("sess-1"));
      expect(data?.pages[0]?.messages).toHaveLength(1); // not duplicated
    });

    it("fast-path applies the first message-new for a session with an empty cached page (not a silent drop)", () => {
      // The session is "open" (its message page is cached) but has zero
      // messages yet — e.g. a brand-new session. This must be distinguished
      // from "session never opened" (no cached page at all): the tracker
      // baseline is 0, so msgSeq 1 is contiguous and applies, not dropped.
      queryClient.setQueryData(
        messagesQueryKey("sess-empty"),
        makeMessagesData({ pages: [{ messages: [], nextBefore: null }] }),
      );
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      emitUpdate({
        ts: 1000,
        body: { t: "message-new", sessionId: "sess-empty", msgSeq: 1, content: box("m1") },
      });

      expect(queryClient.getQueryState(messagesQueryKey("sess-empty"))?.isInvalidated).toBe(false);
      const data = queryClient.getQueryData<MessagesQueryData>(messagesQueryKey("sess-empty"));
      expect(data?.pages[0]?.messages.map((m) => m.seq)).toEqual([1]);
    });

    it("ignores message-new for a session that has no cached message page", () => {
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      expect(() =>
        emitUpdate({
          ts: 4000,
          body: { t: "message-new", sessionId: "sess-unopened", msgSeq: 1, content: box("m1") },
        }),
      ).not.toThrow();

      expect(queryClient.getQueryData(messagesQueryKey("sess-unopened"))).toBeUndefined();
      expect(queryClient.getQueryState(messagesQueryKey("sess-unopened"))).toBeUndefined();
    });

    it("re-seeds the msgSeq tracker after a gap-triggered refetch lands in the cache", () => {
      queryClient.setQueryData(messagesQueryKey("sess-1"), makeMessagesData()); // known = 3
      const { source, emitUpdate } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      emitUpdate({
        ts: 1,
        body: { t: "message-new", sessionId: "sess-1", msgSeq: 10, content: box("gap") },
      });
      expect(queryClient.getQueryState(messagesQueryKey("sess-1"))?.isInvalidated).toBe(true);

      // Simulate the refetch this invalidation triggers landing in the cache.
      queryClient.setQueryData(
        messagesQueryKey("sess-1"),
        makeMessagesData({
          pages: [
            {
              messages: [{ seq: 10, localId: null, content: box("m10"), createdAt: 9 }],
              nextBefore: null,
            },
          ],
          pageParams: [undefined],
        }),
      );

      // The next contiguous update (11) now applies cleanly.
      emitUpdate({
        ts: 2,
        body: { t: "message-new", sessionId: "sess-1", msgSeq: 11, content: box("m11") },
      });
      const data = queryClient.getQueryData<MessagesQueryData>(messagesQueryKey("sess-1"));
      expect(data?.pages[0]?.messages.map((m) => m.seq)).toEqual([11, 10]);
    });
  });

  describe("reconnect", () => {
    it("invalidates every query, not just ['sync']", () => {
      queryClient.setQueryData(syncQueryKey, makeSnapshot());
      queryClient.setQueryData(messagesQueryKey("sess-1"), makeMessagesData());
      const { source, emitReconnect } = createFakeSyncSocket();
      createSyncEngine(queryClient, source);

      emitReconnect();

      expect(queryClient.getQueryState(syncQueryKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(messagesQueryKey("sess-1"))?.isInvalidated).toBe(true);
    });
  });

  describe("dispose", () => {
    it("stops reacting to further socket events and cache updates", () => {
      queryClient.setQueryData(syncQueryKey, makeSnapshot({ headerSeq: 5 }));
      const { source, emitUpdate, emitReconnect } = createFakeSyncSocket();
      const engine = createSyncEngine(queryClient, source);

      engine.dispose();
      expect(() => engine.dispose()).not.toThrow(); // idempotent

      emitUpdate({ seq: 6, ts: 1, body: { t: "session-delete", id: "sess-1" } });
      emitReconnect();

      // Nothing changed — the engine no longer applies fast-paths or invalidates.
      const data = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
      expect(data?.headerSeq).toBe(5);
      expect(queryClient.getQueryState(syncQueryKey)?.isInvalidated).toBe(false);
    });
  });
});
