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
