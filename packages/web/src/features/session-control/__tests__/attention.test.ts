import { describe, expect, it } from "vitest";
import type { RenderItem } from "@/sync/reducer";
import { deriveAttention } from "../attention.js";

function turnEnd(status: "completed" | "failed" | "cancelled", time: number): RenderItem {
  return { id: `end-${time}`, time, role: "agent", kind: "turn-end", status };
}

describe("deriveAttention", () => {
  it("returns null when nothing is outstanding", () => {
    expect(
      deriveAttention({ items: [], ephemeralAttentionKind: null, lastSeenAt: null }),
    ).toBeNull();
  });

  it("returns 'perm' when a perm-placeholder has no decision yet", () => {
    const items: RenderItem[] = [
      {
        id: "p1",
        time: 1,
        role: "agent",
        kind: "perm-placeholder",
        name: "Bash",
        args: {},
        permission: { reqId: "r1", modes: ["default"] },
      },
    ];
    expect(deriveAttention({ items, ephemeralAttentionKind: null, lastSeenAt: null })).toBe("perm");
  });

  it("returns 'perm' for a pending permission nested in a subagent", () => {
    const items: RenderItem[] = [
      {
        id: "t1",
        time: 1,
        role: "agent",
        kind: "tool",
        call: "c1",
        name: "Task",
        args: {},
        status: "running",
        subagent: [
          {
            id: "t2",
            time: 2,
            role: "agent",
            kind: "tool",
            call: "c2",
            name: "Bash",
            args: {},
            status: "running",
            permission: { reqId: "r1", modes: ["default"] },
          },
        ],
      },
    ];
    expect(deriveAttention({ items, ephemeralAttentionKind: null, lastSeenAt: null })).toBe("perm");
  });

  it("'perm' outranks a 'question' ephemeral", () => {
    const items: RenderItem[] = [
      {
        id: "p1",
        time: 1,
        role: "agent",
        kind: "perm-placeholder",
        name: "Bash",
        args: {},
        permission: { reqId: "r1", modes: ["default"] },
      },
    ];
    expect(deriveAttention({ items, ephemeralAttentionKind: "question", lastSeenAt: null })).toBe(
      "perm",
    );
  });

  it("returns 'question' from the ephemeral signal alone (no items-based source exists)", () => {
    expect(
      deriveAttention({ items: [], ephemeralAttentionKind: "question", lastSeenAt: null }),
    ).toBe("question");
  });

  it("returns 'failed' when the last closed turn failed", () => {
    const items = [turnEnd("failed", 100)];
    expect(deriveAttention({ items, ephemeralAttentionKind: null, lastSeenAt: 999 })).toBe(
      "failed",
    );
  });

  it("'failed' is attention-worthy even if it happened before last-seen", () => {
    const items = [turnEnd("failed", 100)];
    expect(deriveAttention({ items, ephemeralAttentionKind: null, lastSeenAt: 500 })).toBe(
      "failed",
    );
  });

  it("returns 'done' when the last closed turn completed after last-seen", () => {
    const items = [turnEnd("completed", 100)];
    expect(deriveAttention({ items, ephemeralAttentionKind: null, lastSeenAt: 50 })).toBe("done");
  });

  it("returns null when the last closed turn completed before last-seen (already seen)", () => {
    const items = [turnEnd("completed", 100)];
    expect(deriveAttention({ items, ephemeralAttentionKind: null, lastSeenAt: 200 })).toBeNull();
  });

  it("returns null when the completed turn has never been seen but lastSeenAt is null (treated as unseen -> 'done')", () => {
    const items = [turnEnd("completed", 100)];
    expect(deriveAttention({ items, ephemeralAttentionKind: null, lastSeenAt: null })).toBe("done");
  });

  it("a cancelled turn is neither 'failed' nor 'done'", () => {
    const items = [turnEnd("cancelled", 100)];
    expect(deriveAttention({ items, ephemeralAttentionKind: null, lastSeenAt: null })).toBeNull();
  });

  it("uses the most recent turn-end when several are present", () => {
    const items = [turnEnd("failed", 100), turnEnd("completed", 200)];
    expect(deriveAttention({ items, ephemeralAttentionKind: null, lastSeenAt: 150 })).toBe("done");
  });
});
