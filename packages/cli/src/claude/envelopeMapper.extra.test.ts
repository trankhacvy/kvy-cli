import { isCuid } from "@paralleldrive/cuid2";
import { describe, expect, it } from "vitest";
import {
  type ClaudeEnvelopeMapperState,
  createClaudeEnvelopeMapperState,
  mapClaudeToEnvelopes,
} from "./envelopeMapper.js";
import type { RawJSONLines } from "./types.js";

// Extra edge-case coverage beyond envelopeMapper.test.ts, probing scenarios
// not exercised by the existing unit tests or golden fixtures.

describe("mapClaudeToEnvelopes — nested ordinary tool call inside a subagent scope", () => {
  it("scopes a non-Task tool call's start/end to the subagent without spuriously emitting sub-stop", () => {
    const state = createClaudeEnvelopeMapperState();

    // Launch the Task.
    mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-task-parent",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_task_nested", name: "Task", input: { prompt: "go" } },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );

    // Subagent's own assistant turn makes an ordinary (non-Task) tool call,
    // linked via parent_tool_use_id (no isSidechain flag set — SDK-style).
    const childStart = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-nested-tool-use",
        parent_tool_use_id: "toolu_task_nested",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_nested_bash", name: "Bash", input: { command: "ls" } },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );

    expect(childStart.some((e) => e.ev.t === "sub-start")).toBe(true);
    const nestedStart = childStart.find((e) => e.ev.t === "tool-start");
    expect(nestedStart).toBeDefined();
    expect(nestedStart?.subagent).toBeDefined();
    expect(isCuid(nestedStart!.subagent!)).toBe(true);
    const subagent = nestedStart?.subagent;

    // The subagent's tool_result for that nested tool call arrives, also
    // linked via parent_tool_use_id, no isSidechain flag.
    const childEnd = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-nested-tool-result",
        parent_tool_use_id: "toolu_task_nested",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_nested_bash", content: "ok" }],
        },
      } as unknown as RawJSONLines,
      state,
    );

    // Must be a normal tool-end (not a sub-stop) scoped to the same subagent —
    // the nested tool's own defensively-minted subagent id must never trigger
    // maybeEmitSubagentStop since it was never in activeSubagents.
    expect(childEnd.some((e) => e.ev.t === "sub-stop")).toBe(false);
    const nestedEnd = childEnd.find((e) => e.ev.t === "tool-end");
    expect(nestedEnd).toBeDefined();
    expect(nestedEnd?.subagent).toBe(subagent);
    expect(nestedEnd?.ev).toMatchObject({ ok: true, output: "ok" });
    if (nestedStart?.ev.t === "tool-start" && nestedEnd?.ev.t === "tool-end") {
      expect(nestedEnd.ev.call).toBe(nestedStart.ev.call);
    }

    // The Task's own tool_result should still correctly emit sub-stop (and
    // no tool-end) once it arrives.
    const taskEnd = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-task-nested-result",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_task_nested", content: "done" }],
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(taskEnd.some((e) => e.ev.t === "sub-stop")).toBe(true);
    expect(taskEnd.some((e) => e.ev.t === "tool-end")).toBe(false);
  });

  it("hides a nested Task's own tool_result even when reported inside a sidechain message", () => {
    // A Task launched *from inside* another subagent's own scope (subagent
    // calling Task itself) reports its own tool_result in a message that is
    // itself isSidechain — this must stay hidden exactly like a top-level
    // Task's tool_result, not leak a dangling tool-end with no tool-start.
    const state = createClaudeEnvelopeMapperState();

    mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "outer-task",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_outer_task", name: "Task", input: { prompt: "outer" } },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );

    // Subagent A (outer Task) itself launches a nested Task (subagent B).
    mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "inner-task-launch",
        isSidechain: true,
        parent_tool_use_id: "toolu_outer_task",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_inner_task", name: "Task", input: { prompt: "inner" } },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );

    // The nested Task's own tool_result arrives inside a sidechain message
    // (subagent A's own transcript scope).
    const nestedTaskResult = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "inner-task-result",
        isSidechain: true,
        parent_tool_use_id: "toolu_outer_task",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_inner_task", content: "inner done" },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );

    expect(nestedTaskResult.some((e) => e.ev.t === "tool-end")).toBe(false);
  });
});

describe("mapClaudeToEnvelopes — turn lifecycle across multiple exchanges", () => {
  it("closes and reopens turns across two full user/assistant exchanges", () => {
    const state = createClaudeEnvelopeMapperState();

    const u1 = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-1",
        message: { role: "user", content: "first prompt" },
      } as unknown as RawJSONLines,
      state,
    );
    expect(u1).toHaveLength(1);
    expect(state.currentTurnId).toBeNull();

    const a1 = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-1",
        message: { role: "assistant", content: [{ type: "text", text: "reply one" }] },
      } as unknown as RawJSONLines,
      state,
    );
    expect(a1.some((e) => e.ev.t === "turn-start")).toBe(true);
    const turn1 = state.currentTurnId;
    expect(turn1).not.toBeNull();

    const u2 = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-2",
        message: { role: "user", content: "second prompt" },
      } as unknown as RawJSONLines,
      state,
    );
    // Second user message closes turn 1 then emits its own user text.
    expect(u2.some((e) => e.ev.t === "turn-end")).toBe(true);
    expect(u2.some((e) => e.ev.t === "text" && e.role === "user")).toBe(true);
    expect(state.currentTurnId).toBeNull();

    const a2 = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-2",
        message: { role: "assistant", content: [{ type: "text", text: "reply two" }] },
      } as unknown as RawJSONLines,
      state,
    );
    const turn2 = state.currentTurnId;
    expect(turn2).not.toBeNull();
    expect(turn2).not.toBe(turn1); // a fresh turn id was minted, not reused
    expect(a2.some((e) => e.ev.t === "turn-start")).toBe(true);
  });
});

describe("mapClaudeToEnvelopes — unknown tool_use name fallback", () => {
  it("falls back to 'unknown' name and an empty title-less tool-start when tool_use has no name", () => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-noname",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_noname", input: { x: 1 } }],
        },
      } as unknown as RawJSONLines,
      state,
    );
    const start = envelopes.find((e) => e.ev.t === "tool-start");
    expect(start?.ev).toMatchObject({ name: "unknown" });
  });
});

describe("mapClaudeToEnvelopes — state re-use across independent sessions", () => {
  it("two independently-constructed states never share minted ids", () => {
    const stateA: ClaudeEnvelopeMapperState = createClaudeEnvelopeMapperState();
    const stateB: ClaudeEnvelopeMapperState = createClaudeEnvelopeMapperState();

    const a = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-shared-id",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_shared", name: "Bash", input: {} }],
        },
      } as unknown as RawJSONLines,
      stateA,
    );
    const b = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-shared-id",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_shared", name: "Bash", input: {} }],
        },
      } as unknown as RawJSONLines,
      stateB,
    );
    const callA = a.find((e) => e.ev.t === "tool-start");
    const callB = b.find((e) => e.ev.t === "tool-start");
    expect(callA?.ev.t).toBe("tool-start");
    expect(callB?.ev.t).toBe("tool-start");
    if (callA?.ev.t === "tool-start" && callB?.ev.t === "tool-start") {
      expect(callA.ev.call).not.toBe(callB.ev.call); // independent mints, same provider id
    }
  });
});
