/**
 * Golden-trace tests replaying REAL recorded adapter sessions through the
 * mapper (plan.md §17 "Phase 2.1 — ACP core": "Golden-trace fixtures
 * recorded from real adapter runs (both providers) feeding the existing
 * reducer test corpus").
 *
 * The fixtures were recorded 2026-07-18 against the pinned
 * `@agentclientprotocol/claude-agent-acp@0.59.0` install (via the adapter
 * manager) driving the machine's authenticated Claude Code, speaking raw
 * NDJSON JSON-RPC — no SDK client in the recorder, so the JSONL is exactly
 * what crossed the wire. Each line: `{dir: 'in'|'out', at, msg}`.
 *
 * These recordings are what surfaced (and now pin down) the two real-stream
 * behaviors the unit fixtures originally got wrong:
 *  1. `agent_message_chunk` arrives as per-delta fragments sharing a
 *     `messageId` ("The" + " command printed ...") → text coalescing.
 *  2. The initial `tool_call` carries `rawInput: {}` / title "Terminal";
 *     args stream in via non-terminal `tool_call_update`s → deferred
 *     tool-start.
 *
 * A recorded permission-request turn is deliberately absent: this machine's
 * real Claude settings auto-allow the candidate commands, and recording
 * under an isolated CLAUDE_CONFIG_DIR loses authentication. The permission
 * path is covered schema-exactly by `acpPermissionHandler.test.ts` and
 * end-to-end by Phase 2.2's manual gate.
 *
 * Codex fixtures follow when Phase 2.3 wires `codex-acp` (recording one
 * needs a Codex login this machine may not have — the harness is provider-
 * agnostic either way).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEnvelope } from "@kvy/wire";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import {
  type AcpSessionUpdate,
  createAcpEnvelopeMapperState,
  endAcpTurn,
  mapAcpUpdateToEnvelopes,
  startAcpTurn,
} from "./acpToEnvelope.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

interface RecordedLine {
  dir: "in" | "out";
  at: number;
  msg: {
    method?: string;
    params?: { update?: AcpSessionUpdate };
    result?: { stopReason?: string };
    id?: number;
  };
}

function loadTrace(name: string): RecordedLine[] {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedLine);
}

/** Replays a recorded session's updates + prompt result through the mapper, exactly as the transport will. */
function replay(name: string): { envelopes: SessionEnvelope[]; logger: Logger } {
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const state = createAcpEnvelopeMapperState();
  const envelopes: SessionEnvelope[] = [startAcpTurn(state)];
  let stopReason = "end_turn";
  for (const line of loadTrace(name)) {
    if (line.dir !== "in") continue;
    if (line.msg.method === "session/update" && line.msg.params?.update) {
      envelopes.push(...mapAcpUpdateToEnvelopes(line.msg.params.update, state, logger));
    }
    if (line.msg.result?.stopReason) stopReason = line.msg.result.stopReason;
  }
  envelopes.push(...endAcpTurn(state, stopReason));
  return { envelopes, logger };
}

describe("golden trace: real text-only turn (acp-text-turn.jsonl)", () => {
  it("maps to turn-start, ONE coalesced text envelope, turn-end completed — nothing else", () => {
    const { envelopes, logger } = replay("acp-text-turn.jsonl");
    expect(envelopes.map((e) => e.ev.t)).toEqual(["turn-start", "text", "turn-end"]);

    const text = envelopes[1];
    expect(text?.ev).toEqual({ t: "text", md: "hello kvy" });
    expect(text?.role).toBe("agent");
    expect(text?.turn).toBe(envelopes[0]?.turn);

    expect(envelopes[2]?.ev).toEqual({ t: "turn-end", status: "completed" });
    // usage_update / available_commands_update dropped silently (debug only).
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("golden trace: real Bash tool turn (acp-tool-turn.jsonl)", () => {
  it("defers tool-start until args stream in, ends with rawOutput, coalesces the reply", () => {
    const { envelopes, logger } = replay("acp-tool-turn.jsonl");
    expect(envelopes.map((e) => e.ev.t)).toEqual([
      "turn-start",
      "tool-start",
      "tool-end",
      "text",
      "turn-end",
    ]);

    const start = envelopes[1];
    expect(start?.ev).toEqual({
      t: "tool-start",
      call: expect.any(String),
      name: "Bash", // from _meta.claudeCode.toolName, not ACP's generic kind
      title: "echo kvy-fixture", // refined from the initial "Terminal"
      args: { command: "echo kvy-fixture" }, // NOT the initial empty rawInput
      risk: "exec",
    });

    const end = envelopes[2];
    expect(end?.ev).toEqual({
      t: "tool-end",
      call: start?.ev.t === "tool-start" ? start.ev.call : "",
      ok: true,
      output: "kvy-fixture",
    });

    // Per-delta chunks ("The" + " command printed `kvy-fixture`.") → one envelope.
    expect(envelopes[3]?.ev).toEqual({ t: "text", md: "The command printed `kvy-fixture`." });
    expect(envelopes[4]?.ev).toEqual({ t: "turn-end", status: "completed" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("every envelope carries the synthesized turn id", () => {
    const { envelopes } = replay("acp-tool-turn.jsonl");
    const turn = envelopes[0]?.turn;
    expect(turn).toBeTruthy();
    for (const envelope of envelopes) expect(envelope.turn).toBe(turn);
  });
});
