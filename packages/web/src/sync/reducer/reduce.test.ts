import { createEnvelope, type SessionEnvelope } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import { reduceEnvelopes } from "./reduce.js";
import type { PermPlaceholderItem, RenderItem, SubagentGroupItem, ToolItem } from "./types.js";

describe("reduceEnvelopes — dedupe", () => {
  it("keeps the first occurrence of a repeated envelope id and drops the rest", () => {
    const env = createEnvelope("agent", { t: "text", md: "hello" }, { id: "e1", time: 1 });
    const items = reduceEnvelopes([env, env, env]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "text", md: "hello" });
  });
});

describe("reduceEnvelopes — ordering", () => {
  it("sorts out-of-order envelopes by time, stably on ties", () => {
    const a = createEnvelope("user", { t: "text", md: "first" }, { id: "a", time: 100 });
    const b = createEnvelope("agent", { t: "text", md: "second" }, { id: "b", time: 50 });
    const c = createEnvelope("agent", { t: "text", md: "third-tie" }, { id: "c", time: 50 });
    // b and c share a time; b was pushed first so it must stay first.
    const items = reduceEnvelopes([a, b, c]);
    expect(items.map((i) => (i as { md?: string }).md)).toEqual(["second", "third-tie", "first"]);
  });
});

describe("reduceEnvelopes — tool-start/tool-end pairing", () => {
  it("pairs a tool-end onto its tool-start by call id", () => {
    const start = createEnvelope(
      "agent",
      { t: "tool-start", call: "c1", name: "Read", args: { path: "a.ts" } },
      { id: "s1", time: 1 },
    );
    const end = createEnvelope(
      "agent",
      { t: "tool-end", call: "c1", ok: true, output: { content: "x" } },
      { id: "e1", time: 2 },
    );
    const items = reduceEnvelopes([start, end]);
    expect(items).toHaveLength(1);
    const tool = items[0] as ToolItem;
    expect(tool.kind).toBe("tool");
    expect(tool.status).toBe("done");
    expect(tool.ok).toBe(true);
    expect(tool.output).toEqual({ content: "x" });
  });

  it("surfaces a tool-end with no matching tool-start as an orphan, not silently", () => {
    const end = createEnvelope(
      "agent",
      { t: "tool-end", call: "unknown", ok: false },
      { id: "e1", time: 1 },
    );
    const items = reduceEnvelopes([end]);
    expect(items).toEqual([
      {
        id: "e1",
        time: 1,
        role: "agent",
        turn: undefined,
        kind: "orphan-tool-end",
        call: "unknown",
        ok: false,
        output: undefined,
      },
    ]);
  });
});

describe("reduceEnvelopes — permission ↔ tool-use matching", () => {
  it("matches a perm-request to its tool-start directly by call id when known", () => {
    const req = createEnvelope(
      "agent",
      {
        t: "perm-request",
        reqId: "r1",
        call: "c1",
        name: "Bash",
        args: { command: "ls" },
        modes: ["default"],
      },
      { id: "req1", time: 1 },
    );
    const start = createEnvelope(
      "agent",
      { t: "tool-start", call: "c1", name: "Bash", args: { command: "ls" } },
      { id: "s1", time: 2 },
    );
    const items = reduceEnvelopes([req, start]);
    expect(items).toHaveLength(1); // no standalone placeholder — call id resolved it immediately
    const tool = items[0] as ToolItem;
    expect(tool.kind).toBe("tool");
    expect(tool.permission?.reqId).toBe("r1");
  });

  it("falls back to name+args matching when the perm-request has no call id, replacing the placeholder in place", () => {
    const req = createEnvelope(
      "agent",
      {
        t: "perm-request",
        reqId: "r1",
        name: "Bash",
        args: { command: "rm -rf x" },
        modes: ["default"],
      },
      { id: "req1", time: 1 },
    );
    const start = createEnvelope(
      "agent",
      { t: "tool-start", call: "c1", name: "Bash", args: { command: "rm -rf x" } },
      { id: "s1", time: 2 },
    );
    const resolve = createEnvelope(
      "agent",
      { t: "perm-resolve", reqId: "r1", decision: { kind: "allow", scope: "once" } },
      { id: "res1", time: 3 },
    );
    const items = reduceEnvelopes([req, start, resolve]);
    expect(items).toHaveLength(1);
    const tool = items[0] as ToolItem;
    expect(tool.kind).toBe("tool");
    expect(tool.call).toBe("c1");
    expect(tool.permission?.decision).toEqual({ kind: "allow", scope: "once" });
  });

  it("matches name+args regardless of key order, FIFO across duplicate pending calls", () => {
    const req1 = createEnvelope(
      "agent",
      { t: "perm-request", reqId: "r1", name: "Bash", args: { a: 1, b: 2 }, modes: ["default"] },
      { id: "req1", time: 1 },
    );
    const req2 = createEnvelope(
      "agent",
      {
        t: "perm-request",
        reqId: "r2",
        name: "Bash",
        args: { b: 2, a: 1 } /* same args, different key order */,
        modes: ["default"],
      },
      { id: "req2", time: 2 },
    );
    const start1 = createEnvelope(
      "agent",
      { t: "tool-start", call: "c1", name: "Bash", args: { a: 1, b: 2 } },
      { id: "s1", time: 3 },
    );
    const start2 = createEnvelope(
      "agent",
      { t: "tool-start", call: "c2", name: "Bash", args: { b: 2, a: 1 } },
      { id: "s2", time: 4 },
    );
    const items = reduceEnvelopes([req1, req2, start1, start2]);
    expect(items).toHaveLength(2);
    expect((items[0] as ToolItem).permission?.reqId).toBe("r1");
    expect((items[0] as ToolItem).call).toBe("c1");
    expect((items[1] as ToolItem).permission?.reqId).toBe("r2");
    expect((items[1] as ToolItem).call).toBe("c2");
  });

  it("renders an unmatched perm-request as a standalone placeholder, never dropped", () => {
    const req = createEnvelope(
      "agent",
      {
        t: "perm-request",
        reqId: "r1",
        name: "Bash",
        args: { command: "ls" },
        modes: ["default", "plan"],
      },
      { id: "req1", time: 1 },
    );
    const items = reduceEnvelopes([req]);
    expect(items).toHaveLength(1);
    const placeholder = items[0] as PermPlaceholderItem;
    expect(placeholder.kind).toBe("perm-placeholder");
    expect(placeholder.permission.decision).toBeUndefined();
  });

  it("silently ignores a perm-resolve whose reqId was never seen in a prior perm-request", () => {
    // Best-effort, never-throw design (task-summary/P1-1.6-reducer-port.md
    // "Assumptions / design notes"): there's no render target for a resolve
    // that doesn't match any known request, so it's a no-op rather than an
    // invented phantom item — and it must not disturb unrelated items.
    const resolve = createEnvelope(
      "agent",
      { t: "perm-resolve", reqId: "never-requested", decision: { kind: "allow", scope: "once" } },
      { id: "res1", time: 1 },
    );
    const text = createEnvelope("agent", { t: "text", md: "hello" }, { id: "t1", time: 2 });
    const items = reduceEnvelopes([resolve, text]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "text", md: "hello" });
  });
});

describe("reduceEnvelopes — subagent/sidechain linking", () => {
  it("nests a subagent scope under the parent tool call sharing its call id", () => {
    const parentStart = createEnvelope(
      "agent",
      { t: "tool-start", call: "task-1", name: "Task", args: { prompt: "investigate" } },
      { id: "p1", time: 1 },
    );
    const subText = createEnvelope(
      "agent",
      { t: "text", md: "working inside subagent" },
      { id: "sub1", time: 2, subagent: "task-1" },
    );
    const parentEnd = createEnvelope(
      "agent",
      { t: "tool-end", call: "task-1", ok: true, output: { summary: "done" } },
      { id: "p2", time: 3 },
    );
    const items = reduceEnvelopes([parentStart, subText, parentEnd]);
    expect(items).toHaveLength(1);
    const tool = items[0] as ToolItem;
    expect(tool.kind).toBe("tool");
    expect(tool.status).toBe("done");
    expect(tool.subagent).toEqual([
      {
        id: "sub1",
        time: 2,
        role: "agent",
        turn: undefined,
        kind: "text",
        md: "working inside subagent",
        thinking: false,
      },
    ]);
  });

  it("surfaces a subagent scope with no matching parent tool call as a standalone group", () => {
    const orphanSub = createEnvelope(
      "agent",
      { t: "text", md: "orphaned subagent output" },
      { id: "sub1", time: 5, subagent: "no-such-call" },
    );
    const items = reduceEnvelopes([orphanSub]);
    expect(items).toHaveLength(1);
    const group = items[0] as SubagentGroupItem;
    expect(group.kind).toBe("subagent-group");
    expect(group.subagentId).toBe("no-such-call");
    expect(group.items).toHaveLength(1);
  });

  it("links nested subagents (subagent-of-subagent) regardless of scope processing order", () => {
    const outerStart = createEnvelope(
      "agent",
      { t: "tool-start", call: "outer-task", name: "Task", args: {} },
      { id: "o1", time: 1 },
    );
    const innerStart = createEnvelope(
      "agent",
      { t: "tool-start", call: "inner-task", name: "Task", args: {} },
      { id: "i1", time: 2, subagent: "outer-task" },
    );
    const innerLeaf = createEnvelope(
      "agent",
      { t: "text", md: "deepest" },
      { id: "leaf", time: 3, subagent: "inner-task" },
    );
    const items = reduceEnvelopes([outerStart, innerStart, innerLeaf]);
    expect(items).toHaveLength(1);
    const outer = items[0] as ToolItem;
    expect(outer.call).toBe("outer-task");
    const inner = outer.subagent?.[0] as ToolItem;
    expect(inner.call).toBe("inner-task");
    expect(inner.subagent).toEqual([
      {
        id: "leaf",
        time: 3,
        role: "agent",
        turn: undefined,
        kind: "text",
        md: "deepest",
        thinking: false,
      },
    ]);
  });
});

describe("reduceEnvelopes — misc event pass-through", () => {
  it("emits every non-tool event kind unchanged", () => {
    const envs: SessionEnvelope[] = [
      createEnvelope("agent", { t: "turn-start" }, { id: "1", time: 1, turn: "t1" }),
      createEnvelope("agent", { t: "service", text: "MCP restarted" }, { id: "2", time: 2 }),
      createEnvelope(
        "agent",
        { t: "file", ref: "up1", name: "a.png", size: 10 },
        { id: "3", time: 3 },
      ),
      createEnvelope(
        "agent",
        { t: "mode-switch", control: "remote", by: "client" },
        { id: "4", time: 4 },
      ),
      createEnvelope(
        "agent",
        { t: "permission-mode", mode: "acceptEdits", source: "terminal" },
        { id: "5", time: 5 },
      ),
      createEnvelope(
        "agent",
        { t: "turn-end", status: "completed" },
        { id: "6", time: 6, turn: "t1" },
      ),
    ];
    const items: RenderItem[] = reduceEnvelopes(envs);
    expect(items.map((i) => i.kind)).toEqual([
      "turn-start",
      "service",
      "file",
      "mode-switch",
      "permission-mode",
      "turn-end",
    ]);
    const permissionModeItem = items.find((i) => i.kind === "permission-mode");
    expect(permissionModeItem).toMatchObject({ mode: "acceptEdits", source: "terminal" });
  });
});

describe("reduceEnvelopes — usage (W4.6)", () => {
  it("maps a usage envelope straight through, costUsd omitted when absent", () => {
    const env = createEnvelope(
      "agent",
      { t: "usage", inputTokens: 120, outputTokens: 45 },
      { id: "u1", time: 1, turn: "t1" },
    );
    const items = reduceEnvelopes([env]);
    expect(items).toEqual([
      {
        id: "u1",
        time: 1,
        role: "agent",
        turn: "t1",
        kind: "usage",
        inputTokens: 120,
        outputTokens: 45,
        costUsd: undefined,
      },
    ]);
  });

  it("carries costUsd through when the adapter supplies it", () => {
    const env = createEnvelope(
      "agent",
      { t: "usage", inputTokens: 4, outputTokens: 5, costUsd: 0.0021 },
      { id: "u2", time: 1 },
    );
    const items = reduceEnvelopes([env]);
    expect(items[0]).toMatchObject({ kind: "usage", costUsd: 0.0021 });
  });
});
