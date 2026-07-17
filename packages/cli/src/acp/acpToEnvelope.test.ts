import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import {
  type AcpSessionUpdate,
  closeAcpTurnWithStatus,
  createAcpEnvelopeMapperState,
  endAcpTurn,
  flushAcpText,
  mapAcpStopReasonToTurnStatus,
  mapAcpUpdateToEnvelopes,
  startAcpTurn,
} from "./acpToEnvelope.js";

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function evs(
  update: AcpSessionUpdate,
  state: ReturnType<typeof createAcpEnvelopeMapperState>,
  logger?: Logger,
): SessionEnvelope[] {
  return mapAcpUpdateToEnvelopes(update, state, logger);
}

describe("turn lifecycle (synthesized around session/prompt)", () => {
  it("startAcpTurn opens a turn; endAcpTurn closes it per stopReason", () => {
    const state = createAcpEnvelopeMapperState();
    const start = startAcpTurn(state);
    expect(start.ev).toEqual({ t: "turn-start" });
    expect(state.currentTurnId).toBeTruthy();
    const turnId = state.currentTurnId;

    const [end] = endAcpTurn(state, "end_turn");
    expect(end?.ev).toEqual({ t: "turn-end", status: "completed" });
    expect(end?.turn).toBe(turnId);
    expect(state.currentTurnId).toBeNull();
  });

  it.each([
    ["end_turn", "completed"],
    ["cancelled", "cancelled"],
    ["max_tokens", "failed"],
    ["max_turn_requests", "failed"],
    ["refusal", "failed"],
    ["some_future_reason", "failed"],
  ] as const)("maps stopReason %s -> %s", (stopReason, status) => {
    expect(mapAcpStopReasonToTurnStatus(stopReason)).toBe(status);
  });

  it("closeAcpTurnWithStatus force-closes an open turn and is a no-op once closed", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const [closed] = closeAcpTurnWithStatus(state, "failed");
    expect(closed?.ev).toEqual({ t: "turn-end", status: "failed" });
    expect(state.currentTurnId).toBeNull();
    expect(closeAcpTurnWithStatus(state, "failed")).toEqual([]);
  });

  it("drops session/update events with no active turn instead of minting one implicitly", () => {
    const state = createAcpEnvelopeMapperState();
    const logger = fakeLogger();
    expect(
      evs(
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        state,
        logger,
      ),
    ).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "acp_session_update_dropped_no_active_turn",
      expect.objectContaining({ sessionUpdate: "agent_message_chunk" }),
    );
  });
});

describe("text chunks (coalesced — one envelope per run, not per delta)", () => {
  it("accumulates consecutive agent_message_chunks and emits ONE text envelope at turn end", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    expect(
      evs({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } }, state),
    ).toEqual([]);
    expect(
      evs(
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo wo" } },
        state,
      ),
    ).toEqual([]);
    expect(
      evs({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "rld" } }, state),
    ).toEqual([]);

    const closed = endAcpTurn(state, "end_turn");
    expect(closed).toHaveLength(2);
    expect(closed[0]?.ev).toEqual({ t: "text", md: "Hello world" });
    expect(closed[0]?.role).toBe("agent");
    expect(closed[1]?.ev).toEqual({ t: "turn-end", status: "completed" });
  });

  it("agent_thought_chunk runs coalesce with thinking:true, and a thinking<->text flip breaks the run", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    evs({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } }, state);
    evs({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "m..." } }, state);

    // Flip to a plain message chunk: the thinking run flushes first.
    const flushed = evs(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } },
      state,
    );
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.ev).toEqual({ t: "text", md: "hmm...", thinking: true });

    const closed = endAcpTurn(state, "end_turn");
    expect(closed[0]?.ev).toEqual({ t: "text", md: "Answer" });
  });

  it("a messageId change breaks the run (distinct assistant messages become distinct envelopes)", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    evs(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "first" },
        messageId: "msg-1",
      },
      state,
    );
    const flushed = evs(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "second" },
        messageId: "msg-2",
      },
      state,
    );
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.ev).toEqual({ t: "text", md: "first" });

    const closed = endAcpTurn(state, "end_turn");
    expect(closed[0]?.ev).toEqual({ t: "text", md: "second" });
  });

  it("a tool_call flushes the open text run first (wire order matches event order)", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    evs(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me check." } },
      state,
    );
    const out = evs(
      { sessionUpdate: "tool_call", toolCallId: "call-1", kind: "read", rawInput: { p: "x" } },
      state,
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.ev).toEqual({ t: "text", md: "Let me check." });
    expect(out[1]?.ev).toMatchObject({ t: "tool-start", name: "read" });
  });

  it("flushAcpText force-flushes the open run (timer-driven latency control for long blocks)", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    evs({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "part" } }, state);
    const flushed = flushAcpText(state);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.ev).toEqual({ t: "text", md: "part" });
    // Nothing left pending afterwards.
    expect(flushAcpText(state)).toEqual([]);
    expect(endAcpTurn(state, "end_turn")).toHaveLength(1); // just turn-end
  });

  it("drops non-text content blocks (logged, not thrown) without breaking the open run", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const logger = fakeLogger();
    evs({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } }, state);
    expect(
      evs({ sessionUpdate: "agent_message_chunk", content: { type: "image" } }, state, logger),
    ).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
    evs({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } }, state);
    const closed = endAcpTurn(state, "end_turn");
    expect(closed[0]?.ev).toEqual({ t: "text", md: "ab" });
  });

  it("drops user_message_chunk silently (no log) — the caller already emitted the prompt", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const logger = fakeLogger();
    expect(
      evs(
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
        state,
        logger,
      ),
    ).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("unknown update kinds", () => {
  it("warns and drops genuinely unrecognized sessionUpdate kinds, never throws", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const logger = fakeLogger();
    expect(() => evs({ sessionUpdate: "some_future_kind" }, state, logger)).not.toThrow();
    expect(evs({ sessionUpdate: "some_future_kind" }, state, logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "acp_session_update_unknown_kind_dropped",
      expect.objectContaining({ sessionUpdate: "some_future_kind" }),
    );
  });
});

describe("tool_call / tool_call_update lifecycle", () => {
  it("tool_call -> tool-start; tool_call_update(completed) -> tool-end", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const [start] = evs(
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "pnpm build",
        kind: "execute",
        rawInput: { command: "pnpm build" },
      },
      state,
    );
    expect(start?.ev).toEqual({
      t: "tool-start",
      call: expect.any(String),
      name: "execute",
      title: "pnpm build",
      args: { command: "pnpm build" },
      risk: "exec",
    });
    const startCall = start?.ev.t === "tool-start" ? start.ev.call : undefined;

    const [end] = evs(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "failed",
        rawOutput: { stderr: "boom" },
      },
      state,
    );
    expect(end?.ev).toEqual({
      t: "tool-end",
      call: startCall,
      ok: false,
      output: { stderr: "boom" },
    });
  });

  it("prefers _meta.claudeCode.toolName for name when present", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const [start] = evs(
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-2",
        kind: "edit",
        rawInput: { file_path: "a.ts" },
        _meta: { claudeCode: { toolName: "Write" } },
      },
      state,
    );
    expect(start?.ev).toMatchObject({ name: "Write", risk: "write" });
  });

  it("drops intermediate pending/in_progress tool_call_update carrying no new args", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    evs({ sessionUpdate: "tool_call", toolCallId: "call-3", rawInput: { c: 1 } }, state);
    expect(
      evs(
        { sessionUpdate: "tool_call_update", toolCallId: "call-3", status: "in_progress" },
        state,
      ),
    ).toEqual([]);
  });

  it("mints a stable cuid2 per raw toolCallId across start/end", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const [start] = evs(
      { sessionUpdate: "tool_call", toolCallId: "call-4", rawInput: { x: 1 } },
      state,
    );
    const [end] = evs(
      { sessionUpdate: "tool_call_update", toolCallId: "call-4", status: "completed" },
      state,
    );
    const startCall = start?.ev.t === "tool-start" ? start.ev.call : undefined;
    const endCall = end?.ev.t === "tool-end" ? end.ev.call : undefined;
    expect(startCall).toBeTruthy();
    expect(startCall).toBe(endCall);
  });

  it("drops a tool_call missing toolCallId (logged, never throws)", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const logger = fakeLogger();
    expect(() => evs({ sessionUpdate: "tool_call" }, state, logger)).not.toThrow();
    expect(evs({ sessionUpdate: "tool_call" }, state, logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith("acp_tool_call_dropped_missing_id", {});
  });
});

describe("deferred tool-start (initial tool_call has empty rawInput — recorded adapter behavior)", () => {
  it("buffers an args-less tool_call, emits tool-start when a refinement fills rawInput in", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    // Real trace shape: tool_call {rawInput:{}, title:"Terminal"} then
    // refinements streaming the command in, then the terminal update.
    expect(
      evs(
        {
          sessionUpdate: "tool_call",
          toolCallId: "toolu_1",
          title: "Terminal",
          kind: "execute",
          rawInput: {},
          _meta: { claudeCode: { toolName: "Bash" } },
        },
        state,
      ),
    ).toEqual([]);

    const refined = evs(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_1",
        title: "echo hi",
        kind: "execute",
        rawInput: { command: "echo hi" },
      },
      state,
    );
    expect(refined).toHaveLength(1);
    expect(refined[0]?.ev).toEqual({
      t: "tool-start",
      call: expect.any(String),
      name: "Bash",
      title: "echo hi",
      args: { command: "echo hi" },
      risk: "exec",
    });

    const [end] = evs(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_1",
        status: "completed",
        rawOutput: "hi",
      },
      state,
    );
    expect(end?.ev).toMatchObject({ t: "tool-end", ok: true, output: "hi" });
  });

  it("a terminal update force-emits the buffered start (with its final refinements) before the end", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    evs({ sessionUpdate: "tool_call", toolCallId: "toolu_2", kind: "read", rawInput: {} }, state);
    const out = evs(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_2",
        status: "completed",
        rawInput: { path: "a.txt" },
        rawOutput: "contents",
      },
      state,
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.ev).toMatchObject({ t: "tool-start", args: { path: "a.txt" } });
    expect(out[1]?.ev).toMatchObject({ t: "tool-end", ok: true, output: "contents" });
  });

  it("turn close flushes still-buffered starts so a cancelled turn never swallows them", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    evs({ sessionUpdate: "tool_call", toolCallId: "toolu_3", kind: "execute" }, state);
    const closed = closeAcpTurnWithStatus(state, "cancelled");
    expect(closed).toHaveLength(2);
    expect(closed[0]?.ev).toMatchObject({ t: "tool-start", args: {} });
    expect(closed[1]?.ev).toEqual({ t: "turn-end", status: "cancelled" });
  });

  it("known-but-unmapped kinds (usage_update etc.) drop at debug, never warn", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const logger = fakeLogger();
    expect(evs({ sessionUpdate: "usage_update" }, state, logger)).toEqual([]);
    expect(evs({ sessionUpdate: "available_commands_update" }, state, logger)).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(2);
  });
});

describe("subagent scope via _meta.claudeCode.parentToolUseId", () => {
  it("scopes a nested tool call and its thinking to the spawning call's own id, with sub-start/sub-stop bracketing", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);

    const [taskStart] = evs(
      {
        sessionUpdate: "tool_call",
        toolCallId: "task-1",
        title: "Investigate",
        kind: "think",
        rawInput: { prompt: "investigate" },
      },
      state,
    );
    const taskCall = taskStart?.ev.t === "tool-start" ? taskStart.ev.call : undefined;
    expect(taskCall).toBeTruthy();

    // Child-scoped thinking buffers into a coalesced run (no emission yet).
    expect(
      evs(
        {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Reasoning..." },
          _meta: { claudeCode: { parentToolUseId: "task-1" } },
        },
        state,
      ),
    ).toEqual([]);

    // The nested tool call flushes the run: sub-start (lazily opening the
    // subagent scope, id = the spawning call's own minted id) precedes the
    // coalesced thinking text, which precedes the nested tool-start.
    const nestedStart = evs(
      {
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
        title: "Read utils.ts",
        kind: "read",
        rawInput: { path: "utils.ts" },
        _meta: { claudeCode: { parentToolUseId: "task-1" } },
      },
      state,
    );
    expect(nestedStart).toHaveLength(3);
    expect(nestedStart[0]?.ev).toEqual({ t: "sub-start" });
    expect(nestedStart[0]?.subagent).toBe(taskCall);
    expect(nestedStart[1]?.ev).toEqual({ t: "text", md: "Reasoning...", thinking: true });
    expect(nestedStart[1]?.subagent).toBe(taskCall);
    expect(nestedStart[2]?.ev).toMatchObject({
      t: "tool-start",
      name: "read",
      title: "Read utils.ts",
    });
    expect(nestedStart[2]?.subagent).toBe(taskCall);
    const nestedCall = nestedStart[2]?.ev.t === "tool-start" ? nestedStart[2].ev.call : undefined;

    // Nested tool_call_update omits _meta — scope must still be remembered from creation.
    const nestedEnd = evs(
      { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" },
      state,
    );
    expect(nestedEnd).toHaveLength(1);
    expect(nestedEnd[0]?.ev).toEqual({ t: "tool-end", call: nestedCall, ok: true });
    expect(nestedEnd[0]?.subagent).toBe(taskCall);

    // The spawning call's own terminal update closes the subagent scope
    // (sub-stop) before its own turn-scoped tool-end.
    const taskEnd = evs(
      { sessionUpdate: "tool_call_update", toolCallId: "task-1", status: "completed" },
      state,
    );
    expect(taskEnd).toHaveLength(2);
    expect(taskEnd[0]?.ev).toEqual({ t: "sub-stop" });
    expect(taskEnd[0]?.subagent).toBe(taskCall);
    expect(taskEnd[1]?.ev).toEqual({ t: "tool-end", call: taskCall, ok: true });
    expect(taskEnd[1]?.subagent).toBeUndefined();
  });

  it("closeAcpTurnWithStatus flushes any still-open subagent scopes before turn-end", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    evs({ sessionUpdate: "tool_call", toolCallId: "task-1", rawInput: { p: 1 } }, state);
    evs(
      {
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
        rawInput: { path: "x" },
        _meta: { claudeCode: { parentToolUseId: "task-1" } },
      },
      state,
    );
    const closed = closeAcpTurnWithStatus(state, "cancelled");
    expect(closed[0]?.ev).toEqual({ t: "sub-stop" });
    expect(closed[1]?.ev).toEqual({ t: "turn-end", status: "cancelled" });
  });
});

describe("state reset across turns", () => {
  it("clears id maps and subagent tracking when a turn closes", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    evs({ sessionUpdate: "tool_call", toolCallId: "call-1", rawInput: { a: 1 } }, state);
    closeAcpTurnWithStatus(state, "completed");

    startAcpTurn(state);
    const logger = fakeLogger();
    // A stale toolCallId from the previous turn resolves to a *new* cuid2 (fresh mint), not the old one.
    const [start] = evs(
      { sessionUpdate: "tool_call", toolCallId: "call-1", rawInput: { a: 1 } },
      state,
      logger,
    );
    expect(start?.ev.t).toBe("tool-start");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
