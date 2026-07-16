import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import type { EventMsg } from "./codexAppServerTypes.js";
import {
  closeCodexTurnWithStatus,
  createCodexEnvelopeMapperState,
  mapCodexEventToEnvelopes,
} from "./envelopeMapper.js";

function evs(
  msg: EventMsg,
  state: ReturnType<typeof createCodexEnvelopeMapperState>,
): SessionEnvelope[] {
  return mapCodexEventToEnvelopes(msg, state);
}

describe("mapCodexEventToEnvelopes: turn lifecycle", () => {
  it("opens a turn on task_started and closes it as completed on task_complete", () => {
    const state = createCodexEnvelopeMapperState();
    const started = evs({ type: "task_started" }, state);
    expect(started).toHaveLength(1);
    expect(started[0]?.ev).toEqual({ t: "turn-start" });
    expect(state.currentTurnId).toBeTruthy();
    const turnId = state.currentTurnId;

    const completed = evs({ type: "task_complete" }, state);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.ev).toEqual({ t: "turn-end", status: "completed" });
    expect(completed[0]?.turn).toBe(turnId);
    expect(state.currentTurnId).toBeNull();
  });

  it("closes as failed when task_complete carries an error", () => {
    const state = createCodexEnvelopeMapperState();
    evs({ type: "task_started" }, state);
    const [closed] = evs({ type: "task_complete", error: "boom" }, state);
    expect(closed?.ev).toEqual({ t: "turn-end", status: "failed" });
  });

  it("closes turn_aborted as cancelled by default, failed when the reason looks like a failure", () => {
    const state = createCodexEnvelopeMapperState();
    evs({ type: "task_started" }, state);
    const [cancelled] = evs({ type: "turn_aborted", reason: "user requested interrupt" }, state);
    expect(cancelled?.ev).toEqual({ t: "turn-end", status: "cancelled" });

    const state2 = createCodexEnvelopeMapperState();
    evs({ type: "task_started" }, state2);
    const [failed] = evs({ type: "turn_aborted", reason: "stream error" }, state2);
    expect(failed?.ev).toEqual({ t: "turn-end", status: "failed" });
  });

  it("drops task_complete/turn_aborted with no open turn instead of emitting a dangling turn-end", () => {
    const state = createCodexEnvelopeMapperState();
    expect(evs({ type: "task_complete" }, state)).toEqual([]);
  });

  it("drops events outside a turn (no task_started yet)", () => {
    const state = createCodexEnvelopeMapperState();
    expect(evs({ type: "agent_message", message: "hi" }, state)).toEqual([]);
  });

  it("closeCodexTurnWithStatus force-closes an open turn for crash/interrupt handling", () => {
    const state = createCodexEnvelopeMapperState();
    evs({ type: "task_started" }, state);
    const [closed] = closeCodexTurnWithStatus(state, "failed");
    expect(closed?.ev).toEqual({ t: "turn-end", status: "failed" });
    expect(state.currentTurnId).toBeNull();
    expect(closeCodexTurnWithStatus(state, "failed")).toEqual([]);
  });
});

describe("mapCodexEventToEnvelopes: text/reasoning", () => {
  it("maps agent_message to text", () => {
    const state = createCodexEnvelopeMapperState();
    evs({ type: "task_started" }, state);
    const [ev] = evs({ type: "agent_message", message: "Hello there" }, state);
    expect(ev?.ev).toEqual({ t: "text", md: "Hello there" });
    expect(ev?.role).toBe("agent");
  });

  it("maps agent_reasoning to a thinking text block", () => {
    const state = createCodexEnvelopeMapperState();
    evs({ type: "task_started" }, state);
    const [ev] = evs({ type: "agent_reasoning", text: "considering options" }, state);
    expect(ev?.ev).toEqual({ t: "text", md: "considering options", thinking: true });
  });

  it("drops agent_reasoning_delta and agent_reasoning_section_break entirely (final agent_reasoning carries the full text)", () => {
    const state = createCodexEnvelopeMapperState();
    evs({ type: "task_started" }, state);
    expect(evs({ type: "agent_reasoning_delta", delta: "cons" }, state)).toEqual([]);
    expect(evs({ type: "agent_reasoning_section_break" }, state)).toEqual([]);
  });
});

describe("mapCodexEventToEnvelopes: exec command", () => {
  it("maps exec_command_begin/end to a matching tool-start/tool-end pair", () => {
    const state = createCodexEnvelopeMapperState();
    evs({ type: "task_started" }, state);

    const [start] = evs(
      { type: "exec_command_begin", call_id: "c1", command: ["ls", "-la"], cwd: "/tmp" },
      state,
    );
    if (!start) throw new Error("expected a tool-start envelope");
    expect(start.ev).toMatchObject({
      t: "tool-start",
      name: "exec",
      title: "ls -la",
      risk: "exec",
    });
    const call = (start.ev as { call: string }).call;
    expect(call).not.toBe("c1"); // provider id never crosses the wire verbatim

    const [end] = evs(
      { type: "exec_command_end", call_id: "c1", exit_code: 0, stdout: "ok" },
      state,
    );
    expect(end?.ev).toMatchObject({ t: "tool-end", call, ok: true });
  });

  it("marks a nonzero exit code as not ok", () => {
    const state = createCodexEnvelopeMapperState();
    evs({ type: "task_started" }, state);
    evs({ type: "exec_command_begin", call_id: "c1", command: ["false"] }, state);
    const [end] = evs(
      { type: "exec_command_end", call_id: "c1", exit_code: 1, stderr: "nope" },
      state,
    );
    expect(end?.ev).toMatchObject({ ok: false });
  });
});

describe("mapCodexEventToEnvelopes: patch apply", () => {
  it("maps patch_apply_begin/end to a matching tool-start/tool-end pair", () => {
    const state = createCodexEnvelopeMapperState();
    evs({ type: "task_started" }, state);

    const [start] = evs(
      {
        type: "patch_apply_begin",
        call_id: "p1",
        changes: { "a.txt": { type: "add", content: "hi" } },
      },
      state,
    );
    if (!start) throw new Error("expected a tool-start envelope");
    expect(start.ev).toMatchObject({ t: "tool-start", name: "apply_patch", risk: "write" });
    const call = (start.ev as { call: string }).call;

    const [end] = evs(
      { type: "patch_apply_end", call_id: "p1", success: false, stderr: "denied" },
      state,
    );
    expect(end?.ev).toMatchObject({ t: "tool-end", call, ok: false });
  });
});

describe("mapCodexEventToEnvelopes: turn_diff", () => {
  it("emits a paired diff tool-start/tool-end only when the unified diff changes", () => {
    const state = createCodexEnvelopeMapperState();
    evs({ type: "task_started" }, state);

    const first = evs({ type: "turn_diff", unified_diff: "diff --git a b" }, state);
    expect(first).toHaveLength(2);
    expect(first[0]?.ev).toMatchObject({ t: "tool-start", name: "codex-diff" });
    expect(first[1]?.ev).toMatchObject({ t: "tool-end", ok: true });

    // Same diff again -> no-op.
    expect(evs({ type: "turn_diff", unified_diff: "diff --git a b" }, state)).toEqual([]);

    // Changed diff -> emits again.
    const second = evs({ type: "turn_diff", unified_diff: "diff --git a c" }, state);
    expect(second).toHaveLength(2);
  });
});

describe("mapCodexEventToEnvelopes: misc", () => {
  it("maps a top-level error event to a service line", () => {
    const state = createCodexEnvelopeMapperState();
    evs({ type: "task_started" }, state);
    const [ev] = evs({ type: "error", message: "rate limited" }, state);
    expect(ev?.ev).toEqual({ t: "service", text: "rate limited" });
  });

  it("drops unknown event types", () => {
    const state = createCodexEnvelopeMapperState();
    evs({ type: "task_started" }, state);
    expect(evs({ type: "token_count", input_tokens: 10 }, state)).toEqual([]);
  });
});
