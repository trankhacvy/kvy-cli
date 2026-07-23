import { describe, expect, it } from "vitest";
import type { RenderItem } from "@/sync/reducer";
import type { MessageRpcResult } from "@/sync/sessionRpc";
import {
  buildFileEnvelope,
  buildMessageEnvelope,
  deliveryNotice,
  mergeRenderItems,
  type PendingMessage,
  pendingToRenderItem,
  reconcileByStatus,
  reconcilePending,
} from "../optimistic-composer.js";

describe("buildMessageEnvelope", () => {
  it("mints a valid user text envelope with a fresh id", () => {
    const envelope = buildMessageEnvelope("hello", 1000);
    expect(envelope.role).toBe("user");
    expect(envelope.ev).toEqual({ t: "text", md: "hello" });
    expect(envelope.time).toBe(1000);
    expect(typeof envelope.id).toBe("string");
    expect(envelope.id.length).toBeGreaterThan(0);
  });

  it("mints a distinct id per call", () => {
    const a = buildMessageEnvelope("hi");
    const b = buildMessageEnvelope("hi");
    expect(a.id).not.toBe(b.id);
  });
});

describe("buildFileEnvelope", () => {
  it("mints a valid user file envelope carrying the blobRef, name, and size", () => {
    const envelope = buildFileEnvelope(
      { ref: "blob-1", name: "diagram.png", size: 4096 },
      { time: 1000 },
    );
    expect(envelope.role).toBe("user");
    expect(envelope.ev).toEqual({ t: "file", ref: "blob-1", name: "diagram.png", size: 4096 });
    expect(envelope.time).toBe(1000);
    expect(typeof envelope.id).toBe("string");
  });

  it("mints a distinct id per call by default", () => {
    const a = buildFileEnvelope({ ref: "b1", name: "a", size: 1 });
    const b = buildFileEnvelope({ ref: "b1", name: "a", size: 1 });
    expect(a.id).not.toBe(b.id);
  });

  it("uses an explicitly given id (the optimistic pending entry's localId)", () => {
    const envelope = buildFileEnvelope({ ref: "b1", name: "a", size: 1 }, { id: "local-123" });
    expect(envelope.id).toBe("local-123");
  });
});

describe("reconcilePending", () => {
  const pending: PendingMessage[] = [
    { kind: "text", localId: "p1", text: "one", sentAt: 1, queued: false },
    { kind: "text", localId: "p2", text: "two", sentAt: 2, queued: true },
  ];

  it("returns the same reference when items contains none of the pending ids", () => {
    const items: RenderItem[] = [
      { id: "other", time: 1, role: "user", kind: "text", md: "x", thinking: false },
    ];
    expect(reconcilePending(pending, items)).toBe(pending);
  });

  it("drops a pending entry once its id lands in items", () => {
    const items: RenderItem[] = [
      { id: "p1", time: 1, role: "user", kind: "text", md: "one", thinking: false },
    ];
    const result = reconcilePending(pending, items);
    expect(result.map((p) => p.localId)).toEqual(["p2"]);
  });

  it("drops all pending entries once every id has landed", () => {
    const items: RenderItem[] = [
      { id: "p1", time: 1, role: "user", kind: "text", md: "one", thinking: false },
      { id: "p2", time: 2, role: "user", kind: "text", md: "two", thinking: false },
    ];
    expect(reconcilePending(pending, items)).toEqual([]);
  });

  it("returns [] immediately for an empty pending list without touching items", () => {
    expect(reconcilePending([], [])).toEqual([]);
  });

  it("falls back to matching by (role: user, text) when the id doesn't match (dropped-id regression)", () => {
    // Simulates the CLI dropping the RPC-delivered id somewhere in its
    // send chain: the landed item's id ("echo-99") has nothing to do with
    // the pending entry's localId ("p1"), but the text matches exactly.
    const items: RenderItem[] = [
      { id: "echo-99", time: 5, role: "user", kind: "text", md: "one", thinking: false },
    ];
    const result = reconcilePending(pending, items);
    expect(result.map((p) => p.localId)).toEqual(["p2"]);
  });

  it("does not content-match a non-text pending entry (attachments always carry a real ref)", () => {
    const filePending: PendingMessage[] = [
      { kind: "file", localId: "p3", name: "x.png", size: 10, sentAt: 3, queued: false },
    ];
    const items: RenderItem[] = [
      // Same name by coincidence, wrong id, and not even the same RenderItem kind — must not match.
      { id: "unrelated", time: 3, role: "user", kind: "text", md: "x.png", thinking: false },
    ];
    expect(reconcilePending(filePending, items)).toEqual(filePending);
  });

  it("claims each landed text item for at most one pending entry (two identical pending sends, one echo)", () => {
    const duplicateText: PendingMessage[] = [
      { kind: "text", localId: "a", text: "same", sentAt: 1, queued: false },
      { kind: "text", localId: "b", text: "same", sentAt: 2, queued: false },
    ];
    const items: RenderItem[] = [
      { id: "echo-1", time: 3, role: "user", kind: "text", md: "same", thinking: false },
    ];
    const result = reconcilePending(duplicateText, items);
    // Exactly one of the two reconciles — the other stays pending until its own echo lands.
    expect(result).toHaveLength(1);
  });

  it("does not content-match an assistant message even if the text happens to be identical", () => {
    const items: RenderItem[] = [
      { id: "unrelated", time: 5, role: "agent", kind: "text", md: "one", thinking: false },
    ];
    expect(reconcilePending(pending, items)).toBe(pending);
  });

  it("reconciles a pending file entry the same way as a pending text entry", () => {
    const filePending: PendingMessage[] = [
      { kind: "file", localId: "p3", name: "x.png", size: 10, sentAt: 3, queued: false },
    ];
    const items: RenderItem[] = [
      { id: "p3", time: 3, role: "user", kind: "file", ref: "blob-1", name: "x.png", size: 10 },
    ];
    expect(reconcilePending(filePending, items)).toEqual([]);
  });

  describe("self-healing fallback for a stuck `queued` entry (docs/user-flows.md fix-plan item 3: stale 'Queued' banner + duplicate bubble)", () => {
    it("drops a still-`queued` entry once a turn closes at/after it was sent, even if neither id nor text ever matches", () => {
      // Reproduces the reported live bug: a message queued behind a running
      // turn gets answered (visible elsewhere in the transcript as a
      // `turn-end` after `sentAt`), but for whatever reason (CLI-side
      // reformatting, a dropped id) neither the id nor exact-text
      // reconciliation above ever confirms it — it must not stay stuck.
      const queuedPending: PendingMessage[] = [
        { kind: "text", localId: "q1", text: "please continue", sentAt: 10, queued: true },
      ];
      const items: RenderItem[] = [
        { id: "t1", time: 5, role: "agent", kind: "turn-start" },
        // Some reformatted/garbled echo that will never content-match "please continue".
        {
          id: "echo-1",
          time: 12,
          role: "user",
          kind: "text",
          md: "please continue.",
          thinking: false,
        },
        { id: "t2", time: 15, role: "agent", kind: "turn-end", status: "completed" },
      ];
      expect(reconcilePending(queuedPending, items)).toEqual([]);
    });

    it("does not force-drop a `queued` entry while only an older turn (closed before it was sent) exists", () => {
      const queuedPending: PendingMessage[] = [
        { kind: "text", localId: "q1", text: "please continue", sentAt: 10, queued: true },
      ];
      const items: RenderItem[] = [
        { id: "t1", time: 1, role: "agent", kind: "turn-start" },
        { id: "t2", time: 2, role: "agent", kind: "turn-end", status: "completed" }, // closed well before sentAt
      ];
      expect(reconcilePending(queuedPending, items)).toBe(queuedPending);
    });

    it("does not force-drop a never-queued (queued: false) entry just because a later turn closes", () => {
      const notQueuedPending: PendingMessage[] = [
        { kind: "text", localId: "q1", text: "please continue", sentAt: 10, queued: false },
      ];
      const items: RenderItem[] = [
        { id: "t2", time: 15, role: "agent", kind: "turn-end", status: "completed" },
      ];
      expect(reconcilePending(notQueuedPending, items)).toBe(notQueuedPending);
    });

    it("still prefers exact text/id matches over the fallback when both are available", () => {
      const queuedPending: PendingMessage[] = [
        { kind: "text", localId: "q1", text: "please continue", sentAt: 10, queued: true },
      ];
      const items: RenderItem[] = [
        {
          id: "echo-1",
          time: 12,
          role: "user",
          kind: "text",
          md: "please continue",
          thinking: false,
        },
      ];
      expect(reconcilePending(queuedPending, items)).toEqual([]);
    });
  });
});

describe("pendingToRenderItem", () => {
  it("renders a pending text message as a user TextItem keyed by its localId", () => {
    const pending: PendingMessage = {
      kind: "text",
      localId: "p1",
      text: "hi there",
      sentAt: 42,
      queued: true,
    };
    expect(pendingToRenderItem(pending)).toEqual({
      id: "p1",
      time: 42,
      role: "user",
      kind: "text",
      md: "hi there",
      thinking: false,
    });
  });

  it("renders a pending file attachment as a user FileItem keyed by its localId", () => {
    const pending: PendingMessage = {
      kind: "file",
      localId: "p2",
      name: "diagram.png",
      size: 2048,
      sentAt: 99,
      queued: false,
    };
    expect(pendingToRenderItem(pending)).toEqual({
      id: "p2",
      time: 99,
      role: "user",
      kind: "file",
      ref: "p2",
      name: "diagram.png",
      size: 2048,
    });
  });
});

describe("mergeRenderItems", () => {
  it("returns items unchanged (same reference) when there's nothing pending", () => {
    const items: RenderItem[] = [{ id: "a", time: 1, role: "agent", kind: "text", md: "hi", thinking: false }];
    expect(mergeRenderItems(items, [])).toBe(items);
  });

  it("slots a pending send into its correct chronological position instead of always appending last", () => {
    // Reproduces the bug: a tool-call result (e.g. an AskUserQuestion card)
    // for a queued message can sync into `items` before this composer's own
    // pending-send echo reconciles — a naive concat would render the result
    // above the message that caused it.
    const items: RenderItem[] = [
      { id: "msg1", time: 100, role: "user", kind: "text", md: "first question please", thinking: false },
      { id: "card1", time: 200, role: "agent", kind: "text", md: "answered", thinking: false },
    ];
    const pending: PendingMessage[] = [
      { kind: "text", localId: "msg2", text: "second question please", sentAt: 150, queued: true },
    ];
    expect(mergeRenderItems(items, pending)).toEqual([
      items[0],
      { id: "msg2", time: 150, role: "user", kind: "text", md: "second question please", thinking: false },
      items[1],
    ]);
  });

  it("keeps confirmed items ahead of a pending send that was sent later", () => {
    const items: RenderItem[] = [
      { id: "a", time: 1, role: "agent", kind: "text", md: "hi", thinking: false },
    ];
    const pending: PendingMessage[] = [
      { kind: "text", localId: "p1", text: "reply", sentAt: 2, queued: false },
    ];
    const merged = mergeRenderItems(items, pending);
    expect(merged.map((item) => item.id)).toEqual(["a", "p1"]);
  });
});

describe("reconcileByStatus (tri-state message RPC reply, design §7.10)", () => {
  const pending: PendingMessage[] = [
    { kind: "text", localId: "p1", text: "one", sentAt: 1, queued: false },
    { kind: "text", localId: "p2", text: "two", sentAt: 2, queued: false },
  ];

  it("status: 'queued' updates the matching entry's `queued` flag, same as legacy behavior", () => {
    const result: MessageRpcResult = { queued: true, status: "queued" };
    const next = reconcileByStatus(pending, "p1", result);
    expect(next).toEqual([
      { kind: "text", localId: "p1", text: "one", sentAt: 1, queued: true },
      { kind: "text", localId: "p2", text: "two", sentAt: 2, queued: false },
    ]);
  });

  it("a legacy reply with no `status` field behaves exactly like 'queued'", () => {
    const result: MessageRpcResult = { queued: true };
    const next = reconcileByStatus(pending, "p1", result);
    expect(next.find((p) => p.localId === "p1")).toMatchObject({ queued: true });
  });

  it("status: 'duplicate' drops the pending entry immediately (reconciled as success) and creates no new entry", () => {
    const result: MessageRpcResult = { queued: false, status: "duplicate" };
    const next = reconcileByStatus(pending, "p1", result);
    expect(next.map((p) => p.localId)).toEqual(["p2"]);
  });

  it("status: 'outcome-unknown' leaves every pending entry untouched (never resent, never dropped)", () => {
    const result: MessageRpcResult = { queued: false, status: "outcome-unknown" };
    const next = reconcileByStatus(pending, "p1", result);
    expect(next).toBe(pending);
  });
});

describe("deliveryNotice (tri-state message RPC reply, design §7.10)", () => {
  it("returns a non-blocking notice only for 'outcome-unknown'", () => {
    expect(deliveryNotice({ queued: false, status: "outcome-unknown" })).toEqual(
      expect.any(String),
    );
  });

  it("returns null for 'queued', 'duplicate', and the legacy status-less shape", () => {
    expect(deliveryNotice({ queued: true, status: "queued" })).toBeNull();
    expect(deliveryNotice({ queued: false, status: "duplicate" })).toBeNull();
    expect(deliveryNotice({ queued: true })).toBeNull();
  });
});
