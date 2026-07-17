import { describe, expect, it } from "vitest";
import type { RenderItem } from "@/sync/reducer";
import {
  buildFileEnvelope,
  buildMessageEnvelope,
  type PendingMessage,
  pendingToRenderItem,
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

  it("reconciles a pending file entry the same way as a pending text entry", () => {
    const filePending: PendingMessage[] = [
      { kind: "file", localId: "p3", name: "x.png", size: 10, sentAt: 3, queued: false },
    ];
    const items: RenderItem[] = [
      { id: "p3", time: 3, role: "user", kind: "file", ref: "blob-1", name: "x.png", size: 10 },
    ];
    expect(reconcilePending(filePending, items)).toEqual([]);
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
