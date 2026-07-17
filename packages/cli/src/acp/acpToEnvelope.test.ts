import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import {
  closeAcpTurnWithStatus,
  createAcpEnvelopeMapperState,
  endAcpTurn,
  mapAcpStopReasonToTurnStatus,
  mapAcpUpdateToEnvelopes,
  startAcpTurn,
  type AcpSessionUpdate,
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
    expect(evs({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }, state, logger)).toEqual(
      [],
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "acp_session_update_dropped_no_active_turn",
      expect.objectContaining({ sessionUpdate: "agent_message_chunk" }),
    );
  });
});

describe("text chunks", () => {
  it("maps agent_message_chunk to text", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const [ev] = evs({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } }, state);
    expect(ev?.ev).toEqual({ t: "text", md: "Hello" });
    expect(ev?.role).toBe("agent");
  });

  it("maps agent_thought_chunk to text{thinking:true}", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const [ev] = evs({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }, state);
    expect(ev?.ev).toEqual({ t: "text", md: "hmm", thinking: true });
  });

  it("drops non-text content blocks (logged, not thrown)", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const logger = fakeLogger();
    expect(evs({ sessionUpdate: "agent_message_chunk", content: { type: "image" } }, state, logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("drops user_message_chunk silently (no log) — the caller already emitted the prompt", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const logger = fakeLogger();
    expect(
      evs({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } }, state, logger),
    ).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("unknown update kinds", () => {
  it("logs and drops unrecognized sessionUpdate kinds, never throws", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const logger = fakeLogger();
    expect(() => evs({ sessionUpdate: "current_mode_update" }, state, logger)).not.toThrow();
    expect(evs({ sessionUpdate: "plan" }, state, logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "acp_session_update_unknown_kind_dropped",
      expect.objectContaining({ sessionUpdate: "plan" }),
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
      { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed", rawOutput: { stderr: "boom" } },
      state,
    );
    expect(end?.ev).toEqual({ t: "tool-end", call: startCall, ok: false, output: { stderr: "boom" } });
  });

  it("prefers _meta.claudeCode.toolName for name when present", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const [start] = evs(
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-2",
        kind: "edit",
        _meta: { claudeCode: { toolName: "Write" } },
      },
      state,
    );
    expect(start?.ev).toMatchObject({ name: "Write", risk: "write" });
  });

  it("drops intermediate pending/in_progress tool_call_update (no wire equivalent)", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    evs({ sessionUpdate: "tool_call", toolCallId: "call-3" }, state);
    expect(evs({ sessionUpdate: "tool_call_update", toolCallId: "call-3", status: "in_progress" }, state)).toEqual(
      [],
    );
  });

  it("mints a stable cuid2 per raw toolCallId across start/end", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    const [start] = evs({ sessionUpdate: "tool_call", toolCallId: "call-4" }, state);
    const [end] = evs({ sessionUpdate: "tool_call_update", toolCallId: "call-4", status: "completed" }, state);
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

describe("subagent scope via _meta.claudeCode.parentToolUseId", () => {
  it("scopes a nested tool call and its thinking to the spawning call's own id, with sub-start/sub-stop bracketing", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);

    const [taskStart] = evs(
      { sessionUpdate: "tool_call", toolCallId: "task-1", title: "Investigate", kind: "think" },
      state,
    );
    const taskCall = taskStart?.ev.t === "tool-start" ? taskStart.ev.call : undefined;
    expect(taskCall).toBeTruthy();

    // First child-scoped update: lazily opens the subagent scope (sub-start),
    // and the subagent id equals the spawning call's own minted id.
    const thinking = evs(
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Reasoning..." },
        _meta: { claudeCode: { parentToolUseId: "task-1" } },
      },
      state,
    );
    expect(thinking).toHaveLength(2);
    expect(thinking[0]?.ev).toEqual({ t: "sub-start" });
    expect(thinking[0]?.subagent).toBe(taskCall);
    expect(thinking[1]?.ev).toEqual({ t: "text", md: "Reasoning...", thinking: true });
    expect(thinking[1]?.subagent).toBe(taskCall);

    const nestedStart = evs(
      {
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
        title: "Read utils.ts",
        kind: "read",
        _meta: { claudeCode: { parentToolUseId: "task-1" } },
      },
      state,
    );
    expect(nestedStart).toHaveLength(1); // subagent already started, no duplicate sub-start
    expect(nestedStart[0]?.subagent).toBe(taskCall);
    const nestedCall = nestedStart[0]?.ev.t === "tool-start" ? nestedStart[0].ev.call : undefined;

    // Nested tool_call_update omits _meta — scope must still be remembered from creation.
    const nestedEnd = evs({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" }, state);
    expect(nestedEnd).toHaveLength(1);
    expect(nestedEnd[0]?.ev).toEqual({ t: "tool-end", call: nestedCall, ok: true });
    expect(nestedEnd[0]?.subagent).toBe(taskCall);

    // The spawning call's own terminal update closes the subagent scope
    // (sub-stop) before its own turn-scoped tool-end.
    const taskEnd = evs({ sessionUpdate: "tool_call_update", toolCallId: "task-1", status: "completed" }, state);
    expect(taskEnd).toHaveLength(2);
    expect(taskEnd[0]?.ev).toEqual({ t: "sub-stop" });
    expect(taskEnd[0]?.subagent).toBe(taskCall);
    expect(taskEnd[1]?.ev).toEqual({ t: "tool-end", call: taskCall, ok: true });
    expect(taskEnd[1]?.subagent).toBeUndefined();
  });

  it("closeAcpTurnWithStatus flushes any still-open subagent scopes before turn-end", () => {
    const state = createAcpEnvelopeMapperState();
    startAcpTurn(state);
    evs({ sessionUpdate: "tool_call", toolCallId: "task-1" }, state);
    evs(
      {
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
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
    evs({ sessionUpdate: "tool_call", toolCallId: "call-1" }, state);
    closeAcpTurnWithStatus(state, "completed");

    startAcpTurn(state);
    const logger = fakeLogger();
    // A stale toolCallId from the previous turn resolves to a *new* cuid2 (fresh mint), not the old one.
    const [start] = evs({ sessionUpdate: "tool_call", toolCallId: "call-1" }, state, logger);
    expect(start?.ev.t).toBe("tool-start");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
