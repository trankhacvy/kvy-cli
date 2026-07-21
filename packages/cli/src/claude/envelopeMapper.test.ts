import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SessionEnvelope } from "@falcon/wire";
import { isCuid } from "@paralleldrive/cuid2";
import { describe, expect, it } from "vitest";
import {
  type ClaudeEnvelopeMapperState,
  closeClaudeTurnWithStatus,
  createClaudeEnvelopeMapperState,
  mapClaudeToEnvelopes,
} from "./envelopeMapper.js";
import type { RawJSONLines } from "./types.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
}

function loadFixtureLines(name: string): unknown[] {
  return readFileSync(fixture(name), "utf-8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function mapAll(rows: unknown[], state: ClaudeEnvelopeMapperState): SessionEnvelope[] {
  return rows.flatMap((row) => mapClaudeToEnvelopes(row as RawJSONLines, state));
}

describe("mapClaudeToEnvelopes — basic message shapes", () => {
  it("maps a plain user string message to a user text envelope, no turn opened", () => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-1",
        message: { role: "user", content: "hello from user" },
      } as unknown as RawJSONLines,
      state,
    );

    expect(state.currentTurnId).toBeNull();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ role: "user", ev: { t: "text", md: "hello from user" } });
    expect(envelopes[0]?.turn).toBeUndefined();
  });

  it("maps non-tool user array content to user text + an inline file envelope for the image, without opening a turn", () => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-array-1",
        isSidechain: false,
        message: {
          role: "user",
          content: [
            { type: "text", text: "look at this image" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );

    expect(state.currentTurnId).toBeNull();
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({
      role: "user",
      ev: { t: "text", md: "look at this image" },
    });
    expect(envelopes[1]).toMatchObject({
      role: "user",
      ev: { t: "file", ref: "inline:abc", name: "image.png", size: 2 },
    });
  });

  it("skips isMeta synthetic user messages entirely", () => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-meta-1",
        isMeta: true,
        message: { role: "user", content: "a huge injected skill prompt..." },
      } as unknown as RawJSONLines,
      state,
    );
    expect(envelopes).toHaveLength(0);
  });

  it("opens a turn and maps assistant text + thinking blocks", () => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "working..." },
            { type: "thinking", thinking: "internal reasoning" },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );

    expect(state.currentTurnId).not.toBeNull();
    expect(envelopes).toHaveLength(3);
    expect(envelopes[0]?.ev.t).toBe("turn-start");
    expect(envelopes[1]?.ev).toEqual({ t: "text", md: "working..." });
    expect(envelopes[2]?.ev).toEqual({ t: "text", md: "internal reasoning", thinking: true });
  });

  it("does not emit envelopes for summary / system lines", () => {
    const state = createClaudeEnvelopeMapperState();
    state.currentTurnId = "turn-1";

    const summary = mapClaudeToEnvelopes(
      { type: "summary", summary: "Done", leafUuid: "leaf-1" } as unknown as RawJSONLines,
      state,
    );
    expect(summary).toHaveLength(0);

    const system = mapClaudeToEnvelopes(
      { type: "system", uuid: "sys-1" } as unknown as RawJSONLines,
      state,
    );
    expect(system).toHaveLength(0);
  });

  it("maps a local-command-stdout result (e.g. /model) to a quiet service marker with tags/ANSI stripped, no turn opened (BF1.2)", () => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "local-cmd-stdout-1",
        isSidechain: false,
        message: {
          role: "user",
          content:
            "<local-command-stdout>Set model to [1mHaiku 4.5[22m and saved as your default for new sessions.</local-command-stdout>",
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      role: "agent",
      ev: {
        t: "service",
        text: "Set model to Haiku 4.5 and saved as your default for new sessions.",
      },
    });
    expect(envelopes[0]?.turn).toBeUndefined();
    expect(state.currentTurnId).toBeNull();
  });

  it("drops a bare local-command invocation record (no stdout yet) instead of showing a raw chat bubble (BF1.2)", () => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "local-cmd-invocation-1",
        isSidechain: false,
        message: {
          role: "user",
          content: "<command-message>model</command-message><command-name>/model</command-name>",
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(envelopes).toHaveLength(0);
  });

  it("extracts local-command-stdout even when surrounded by stray ANSI noise outside the tags (BF1.2)", () => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "local-cmd-stdout-noisy-1",
        isSidechain: false,
        message: {
          role: "user",
          content:
            "[2m<local-command-stdout>Set model to Haiku 4.5 and saved as your default for new sessions.</local-command-stdout>[0m",
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      role: "agent",
      ev: {
        t: "service",
        text: "Set model to Haiku 4.5 and saved as your default for new sessions.",
      },
    });
  });

  it("does not close an already-open turn when a local-command-stdout result arrives mid-turn (BF1.2)", () => {
    // Regression probe: ordinary user chat text closes the current turn
    // (`closeTurn(state, "completed", envelopes)`) before pushing its own
    // envelope. The local-command-stdout branch returns early without ever
    // calling closeTurn/ensureTurn, so a turn left open by an in-flight
    // assistant response is NOT closed by an interleaved local command —
    // documenting the current (asymmetric) behavior rather than asserting
    // it's correct.
    const state = createClaudeEnvelopeMapperState();
    mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-open-turn",
        message: { role: "assistant", content: [{ type: "text", text: "working..." }] },
      } as unknown as RawJSONLines,
      state,
    );
    expect(state.currentTurnId).not.toBeNull();
    const openTurnId = state.currentTurnId;

    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "local-cmd-stdout-mid-turn",
        isSidechain: false,
        message: {
          role: "user",
          content:
            "<local-command-stdout>Set model to Haiku 4.5 and saved as your default for new sessions.</local-command-stdout>",
        },
      } as unknown as RawJSONLines,
      state,
    );

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.ev.t).toBe("service");
    // The turn opened by the preceding assistant text is still open —
    // no turn-end envelope was emitted, and state.currentTurnId is unchanged.
    expect(envelopes.some((e) => e.ev.t === "turn-end")).toBe(false);
    expect(state.currentTurnId).toBe(openTurnId);
  });

  it("still emits a (empty) service marker for a local-command-stdout tag pair with no inner content (BF1.2 edge case)", () => {
    // extractLocalCommandStdout's `match?.[1]?.trim() ?? null` only falls
    // back to null when the tag pair itself is absent — an empty capture
    // group trims to "", which is not null, so this path is NOT dropped
    // the way a bare invocation is. Documenting the current behavior rather
    // than asserting it's desirable: an empty-text `service` envelope is
    // still minted.
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "local-cmd-stdout-empty-1",
        isSidechain: false,
        message: {
          role: "user",
          content: "<local-command-stdout></local-command-stdout>",
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ role: "agent", ev: { t: "service", text: "" } });
  });

  it("routes a local-command-stdout result through the quiet service path even inside a sidechain, instead of the subagent text branch (BF1.2)", () => {
    // The stdout/invocation checks run before `isSidechainMessage`, so a
    // /model result recorded mid-subagent-conversation still becomes a
    // top-level service marker (no turn/subagent scoping) rather than
    // subagent chat text — documenting the current precedence, not a
    // claimed requirement.
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "local-cmd-stdout-sidechain-1",
        isSidechain: true,
        message: {
          role: "user",
          content:
            "<local-command-stdout>Set model to Haiku 4.5 and saved as your default for new sessions.</local-command-stdout>",
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      role: "agent",
      ev: {
        t: "service",
        text: "Set model to Haiku 4.5 and saved as your default for new sessions.",
      },
    });
    expect(envelopes[0]?.subagent).toBeUndefined();
    expect(envelopes[0]?.turn).toBeUndefined();
  });

  it("maps a compact-summary assistant line to a quiet service marker, not the summary text, no turn opened (W4.6)", () => {
    const state = createClaudeEnvelopeMapperState();
    state.currentTurnId = "turn-1";

    const compact = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "compact-1",
        isCompactSummary: true,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "long compaction summary" }],
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(compact).toHaveLength(1);
    expect(compact[0]).toMatchObject({
      role: "agent",
      ev: { t: "service", text: "History compacted (/clear)" },
    });
    expect(compact[0]?.turn).toBeUndefined();
    expect(state.currentTurnId).toBe("turn-1"); // untouched — no turn opened for it
  });

  it("emits a usage envelope from an assistant record's message.usage, alongside its text (W4.6)", () => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-usage-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "lol" }],
          usage: {
            input_tokens: 4,
            cache_creation_input_tokens: 17755,
            cache_read_input_tokens: 0,
            output_tokens: 5,
            service_tier: "standard",
          },
        },
      } as unknown as RawJSONLines,
      state,
    );

    expect(envelopes).toHaveLength(3);
    expect(envelopes[0]?.ev.t).toBe("turn-start");
    expect(envelopes[1]?.ev).toEqual({ t: "text", md: "lol" });
    expect(envelopes[2]).toMatchObject({
      role: "agent",
      turn: state.currentTurnId,
      ev: { t: "usage", inputTokens: 4, outputTokens: 5 },
    });
  });

  it("emits no usage envelope when message.usage is missing or malformed", () => {
    const state = createClaudeEnvelopeMapperState();

    const noUsage = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-no-usage",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      } as unknown as RawJSONLines,
      state,
    );
    expect(noUsage.some((e) => e.ev.t === "usage")).toBe(false);

    const malformed = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-bad-usage",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi again" }],
          usage: { input_tokens: "4", output_tokens: 5 },
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(malformed.some((e) => e.ev.t === "usage")).toBe(false);
  });
});

describe("mapClaudeToEnvelopes — tool call lifecycle", () => {
  it("maps tool_use/tool_result to a tool-start/tool-end pair with a stable minted call id", () => {
    const state = createClaudeEnvelopeMapperState();

    const started = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-2",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_bash_1", name: "Bash", input: { command: "ls" } },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );

    const startEnvelope = started.find((e) => e.ev.t === "tool-start");
    expect(startEnvelope?.ev).toMatchObject({
      t: "tool-start",
      name: "Bash",
      args: { command: "ls" },
    });
    expect(startEnvelope?.ev.t).toBe("tool-start");
    const call = startEnvelope?.ev.t === "tool-start" ? startEnvelope.ev.call : undefined;
    expect(call).toBeDefined();
    expect(isCuid(call!)).toBe(true);
    expect(call).not.toBe("toolu_bash_1"); // provider id must never cross the wire

    const ended = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-2",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_bash_1", content: "ok" }],
        },
      } as unknown as RawJSONLines,
      state,
    );

    const endEnvelope = ended.find((e) => e.ev.t === "tool-end");
    expect(endEnvelope?.ev).toEqual({ t: "tool-end", call, ok: true, output: "ok" });
  });

  it("maps a failed tool_result (is_error) to ok:false", () => {
    const state = createClaudeEnvelopeMapperState();
    mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-fail-1",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_fail_1", name: "Write", input: { file_path: "x" } },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );
    const ended = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-fail-1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_fail_1", content: "boom", is_error: true },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(ended.find((e) => e.ev.t === "tool-end")?.ev).toMatchObject({ ok: false });
  });

  it("never re-mints a call id for a repeated provider tool_use id", () => {
    const state = createClaudeEnvelopeMapperState();
    const first = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-dup-1",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_dup", name: "Bash", input: {} }],
        },
      } as unknown as RawJSONLines,
      state,
    );
    const second = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-dup-2",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_dup", name: "Bash", input: {} }],
        },
      } as unknown as RawJSONLines,
      state,
    );
    const c1 = first.find((e) => e.ev.t === "tool-start");
    const c2 = second.find((e) => e.ev.t === "tool-start");
    expect(c1?.ev.t).toBe("tool-start");
    expect(c2?.ev.t).toBe("tool-start");
    if (c1?.ev.t === "tool-start" && c2?.ev.t === "tool-start") {
      expect(c1.ev.call).toBe(c2.ev.call);
    }
  });
});

/** plan-v2.md W3.3 — PTY-path parity: the same static `RISK_BY_KIND`-style
 * map ACP's `acpToEnvelope.ts` uses, ported to Claude Code's raw tool names. */
describe("mapClaudeToEnvelopes — static tool risk map", () => {
  function toolStart(name: string, callId: string): RawJSONLines {
    return {
      type: "assistant",
      uuid: `a-risk-${callId}`,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: callId, name, input: {} }],
      },
    } as unknown as RawJSONLines;
  }

  it.each([
    ["Bash", "exec"],
    ["Edit", "write"],
    ["Write", "write"],
    ["MultiEdit", "write"],
    ["NotebookEdit", "write"],
    ["Read", "read"],
    ["Grep", "read"],
    ["Glob", "read"],
    ["LS", "read"],
    ["WebFetch", "network"],
    ["WebSearch", "network"],
  ] as const)("tags %s tool-start with risk %s", (name, risk) => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(toolStart(name, `toolu_${name}`), state);
    const start = envelopes.find((e) => e.ev.t === "tool-start");
    expect(start?.ev).toMatchObject({ name, risk });
  });

  it("leaves risk unset for a tool name outside the static map", () => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(toolStart("SomeMcpTool", "toolu_mcp"), state);
    const start = envelopes.find((e) => e.ev.t === "tool-start");
    expect(start?.ev.t === "tool-start" && "risk" in start.ev).toBe(false);
  });
});

/** plan-v2.md W3.2 — image blocks -> wire `file` envelopes (inline, ≤256KB)
 * or a `service` fallback note when the payload is too large. */
describe("mapClaudeToEnvelopes — image blocks", () => {
  it("maps a small image tool_result nested content block to an inline file envelope after its tool-end", () => {
    const state = createClaudeEnvelopeMapperState();
    mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-img-1",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_read_img", name: "Read", input: { file_path: "x.png" } },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-img-1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read_img",
              content: [
                { type: "text", text: "here is the image" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/jpeg", data: "aGVsbG8=" },
                },
              ],
            },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );

    const endIndex = envelopes.findIndex((e) => e.ev.t === "tool-end");
    const fileEnvelope = envelopes.find((e) => e.ev.t === "file");
    expect(endIndex).toBeGreaterThanOrEqual(0);
    expect(fileEnvelope).toBeDefined();
    expect(envelopes.indexOf(fileEnvelope!)).toBeGreaterThan(endIndex);
    expect(fileEnvelope?.ev).toMatchObject({
      t: "file",
      ref: "inline:aGVsbG8=",
      name: "image.jpg",
    });
    // tool-end's own `output` keeps the raw (untouched) content array too.
    const endEnvelope = envelopes.find((e) => e.ev.t === "tool-end");
    expect(endEnvelope?.ev).toMatchObject({ ok: true });
  });

  it("falls back to a service note when the inline image would exceed the 256KB cap", () => {
    const state = createClaudeEnvelopeMapperState();
    const hugeBase64 = "A".repeat(400_000); // ~300KB decoded, over the cap
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-img-big",
        isSidechain: false,
        message: {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: hugeBase64 },
            },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      role: "user",
      ev: { t: "service", text: "image omitted (too large)" },
    });
  });

  it("ignores an image block with an unrecognized source shape instead of crashing", () => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-img-bad",
        isSidechain: false,
        message: {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://example.com/x.png" } }],
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(envelopes).toHaveLength(0);
  });

  it("ignores an image block with an empty base64 data string instead of crashing", () => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-img-empty",
        isSidechain: false,
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(envelopes).toHaveLength(0);
  });

  it("ignores an image block missing media_type/data fields instead of crashing", () => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-img-missing",
        isSidechain: false,
        message: {
          role: "user",
          content: [{ type: "image", source: { type: "base64" } }],
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(envelopes).toHaveLength(0);
  });

  it("maps a top-level image sibling in the mixed tool-result loop to an 'agent'-role file envelope (not 'user')", () => {
    // Distinct from the plain (non-tool-result) user loop tested above, which
    // pushes a "user"-role file envelope — a top-level image block that sits
    // alongside a `tool_result` in the same content array takes the mixed
    // loop's branch instead (envelopeMapper.ts:778), which always pushes as
    // "agent" and inside the open turn/subagent scope.
    const state = createClaudeEnvelopeMapperState();
    mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-sibling-1",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_sibling", name: "Bash", input: { command: "ls" } },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-sibling-1",
        isSidechain: false,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_sibling", content: "ok" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "sibling-data" },
            },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );

    const fileEnvelope = envelopes.find((e) => e.ev.t === "file");
    expect(fileEnvelope).toBeDefined();
    expect(fileEnvelope?.role).toBe("agent");
    expect(fileEnvelope?.turn).toBe(state.currentTurnId);
    expect(fileEnvelope?.ev).toMatchObject({ t: "file", ref: "inline:sibling-data" });
  });

  it.each([
    ["image/png", "image.png"],
    ["image/jpeg", "image.jpg"],
    ["image/gif", "image.gif"],
    ["image/webp", "image.webp"],
    ["image/bmp", "image.png"], // unrecognized media type -> png default
  ] as const)("names the inline file %s -> %s", (mediaType, expectedName) => {
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: `u-ext-${mediaType}`,
        isSidechain: false,
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: "x" } },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.ev).toMatchObject({ t: "file", name: expectedName });
  });
});

describe("mapClaudeToEnvelopes — Task subagent registration", () => {
  it("registers a subagent with no visible parent card for a Task tool_use", () => {
    const state = createClaudeEnvelopeMapperState();
    const started = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-task-1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_task_1",
              name: "Task",
              input: { description: "Search docs", prompt: "Search the docs for X" },
            },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );
    expect(started.some((e) => e.ev.t === "tool-start")).toBe(false);
  });

  it("uses parent_tool_use_id to start a subagent scope and emits sub-start once", () => {
    const state = createClaudeEnvelopeMapperState();
    mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-task-2",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_task_2", name: "Task", input: { prompt: "do work" } },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );

    const child = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-side-1",
        parent_tool_use_id: "toolu_task_2",
        message: { role: "assistant", content: [{ type: "text", text: "sidechain text" }] },
      } as unknown as RawJSONLines,
      state,
    );

    expect(child).toHaveLength(2);
    expect(child[0]?.ev).toEqual({ t: "sub-start" });
    expect(child[1]?.ev).toEqual({ t: "text", md: "sidechain text" });
    const subagent = child[0]?.subagent;
    expect(subagent).toBeDefined();
    expect(isCuid(subagent!)).toBe(true);
    expect(subagent).not.toBe("toolu_task_2");
    expect(child[1]?.subagent).toBe(subagent);

    // a second child message referencing the same Task must not re-emit sub-start
    const child2 = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-side-2",
        parent_tool_use_id: "toolu_task_2",
        message: { role: "assistant", content: [{ type: "text", text: "more sidechain text" }] },
      } as unknown as RawJSONLines,
      state,
    );
    expect(child2).toHaveLength(1);
    expect(child2[0]?.ev).toEqual({ t: "text", md: "more sidechain text" });
  });

  it("buffers orphaned children until the Task tool_use registers, then replays them in order", () => {
    const state = createClaudeEnvelopeMapperState();

    const buffered = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-orphan-1",
        parent_tool_use_id: "toolu_task_3",
        message: { role: "assistant", content: [{ type: "text", text: "buffer me first" }] },
      } as unknown as RawJSONLines,
      state,
    );
    expect(buffered).toHaveLength(0);

    const buffered2 = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-orphan-2",
        parentUuid: "a-orphan-1",
        message: { role: "assistant", content: [{ type: "text", text: "buffer me second" }] },
      } as unknown as RawJSONLines,
      state,
    );
    expect(buffered2).toHaveLength(0);

    const parent = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-parent-1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_task_3",
              name: "Task",
              input: { prompt: "run side task" },
            },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );

    expect(parent.some((e) => e.ev.t === "tool-start")).toBe(false);
    const texts = parent
      .filter((e) => e.ev.t === "text")
      .map((e) => (e.ev.t === "text" ? e.ev.md : undefined));
    expect(texts).toEqual(["buffer me first", "buffer me second"]);
    // registration (sub-start) happens before the replayed buffered text,
    // and only once even though two buffered messages share the subagent
    expect(parent.filter((e) => e.ev.t === "sub-start")).toHaveLength(1);
    const subStartIndex = parent.findIndex((e) => e.ev.t === "sub-start");
    const firstTextIndex = parent.findIndex((e) => e.ev.t === "text");
    expect(subStartIndex).toBeLessThan(firstTextIndex);
  });

  it("emits sub-stop (not tool-end) when the Task's own tool_result arrives", () => {
    const state = createClaudeEnvelopeMapperState();
    mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-task-4",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_task_4", name: "Task", input: { prompt: "work" } },
          ],
        },
      } as unknown as RawJSONLines,
      state,
    );
    mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-side-4",
        parent_tool_use_id: "toolu_task_4",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      } as unknown as RawJSONLines,
      state,
    );

    const stopped = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "u-task-4",
        isSidechain: false,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_task_4", content: "done" }],
        },
      } as unknown as RawJSONLines,
      state,
    );

    expect(stopped.some((e) => e.ev.t === "tool-end")).toBe(false);
    expect(stopped.some((e) => e.ev.t === "sub-stop")).toBe(true);
  });

  it("infers the subagent from the Task prompt when parent_tool_use_id is absent", () => {
    const state = createClaudeEnvelopeMapperState();
    const prompt = "Search for TypeScript 5.6 features";

    mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "task-parent",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_prompt_1", name: "Task", input: { prompt } }],
        },
      } as unknown as RawJSONLines,
      state,
    );

    const root = mapClaudeToEnvelopes(
      {
        type: "user",
        uuid: "sidechain-root",
        isSidechain: true,
        parentUuid: null,
        message: { role: "user", content: prompt },
      } as unknown as RawJSONLines,
      state,
    );

    expect(root).toHaveLength(2);
    expect(root[0]?.ev).toEqual({ t: "sub-start" });
    expect(root[1]?.ev).toEqual({ t: "text", md: prompt });
    const subagent = root[0]?.subagent;
    expect(subagent).toBeDefined();
    expect(isCuid(subagent!)).toBe(true);

    const child = mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "sidechain-child",
        isSidechain: true,
        parentUuid: "sidechain-root",
        message: { role: "assistant", content: [{ type: "text", text: "subagent result" }] },
      } as unknown as RawJSONLines,
      state,
    );
    expect(child).toHaveLength(1);
    expect(child[0]?.subagent).toBe(subagent);
    expect(child[0]?.ev).toEqual({ t: "text", md: "subagent result" });
  });
});

describe("closeClaudeTurnWithStatus", () => {
  it("emits turn-end with the given status when a turn is active", () => {
    const state = createClaudeEnvelopeMapperState();
    state.currentTurnId = "turn-1";
    const envelopes = closeClaudeTurnWithStatus(state, "cancelled");
    expect(state.currentTurnId).toBeNull();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.ev).toEqual({ t: "turn-end", status: "cancelled" });
  });

  it("is a no-op when no turn is active", () => {
    const state = createClaudeEnvelopeMapperState();
    expect(closeClaudeTurnWithStatus(state, "failed")).toHaveLength(0);
  });

  it("stops active subagents before ending an aborted turn", () => {
    const state = createClaudeEnvelopeMapperState();
    mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-abort-task",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_abort", name: "Task", input: { prompt: "p" } }],
        },
      } as unknown as RawJSONLines,
      state,
    );
    mapClaudeToEnvelopes(
      {
        type: "assistant",
        uuid: "a-abort-child",
        parent_tool_use_id: "toolu_abort",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      } as unknown as RawJSONLines,
      state,
    );

    const envelopes = closeClaudeTurnWithStatus(state, "cancelled");
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]?.ev).toEqual({ t: "sub-stop" });
    expect(envelopes[1]?.ev).toEqual({ t: "turn-end", status: "cancelled" });
  });
});

describe("golden fixtures — real Claude Code transcripts", () => {
  it("0-say-lol-session.jsonl: single assistant text turn, no crash", () => {
    const rows = loadFixtureLines("0-say-lol-session.jsonl");
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapAll(rows, state);

    expect(envelopes.some((e) => e.ev.t === "turn-start")).toBe(true);
    const text = envelopes.find((e) => e.role === "agent" && e.ev.t === "text");
    expect(text?.ev).toEqual({ t: "text", md: "lol" });
  });

  it("1-continue-run-ls-tool.jsonl: summary skipped, user prompt closes/opens turns, LS tool round-trips", () => {
    const rows = loadFixtureLines("1-continue-run-ls-tool.jsonl");
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapAll(rows, state);

    // the leading `{"type":"summary",...}` line must never surface as an
    // envelope: 2 user texts, 2 turn-starts, 1 turn-end, 1 assistant text,
    // 1 tool-start, 1 tool-end, 3 usage envelopes (one per real assistant
    // record in this fixture, each carrying a `message.usage`, W4.6) —
    // nothing extra leaked through for the summary line itself.
    expect(envelopes).toHaveLength(12);
    expect(envelopes.filter((e) => e.ev.t === "usage")).toHaveLength(3);

    const starts = envelopes.filter((e) => e.ev.t === "tool-start");
    const ends = envelopes.filter((e) => e.ev.t === "tool-end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0]?.ev.t).toBe("tool-start");
    expect(ends[0]?.ev.t).toBe("tool-end");
    if (starts[0]?.ev.t === "tool-start" && ends[0]?.ev.t === "tool-end") {
      expect(starts[0].ev.name).toBe("LS");
      expect(ends[0].ev.call).toBe(starts[0].ev.call);
      expect(ends[0].ev.ok).toBe(true);
    }

    // "say lol" (turn 1) then "run ls tool " (turn 2): turn-end fires once
    // between them, closing the first turn on the second user prompt.
    expect(envelopes.filter((e) => e.ev.t === "turn-end")).toHaveLength(1);
  });

  it("task_sdk.jsonl: Task tool_use/tool_result never surface a tool card, unrelated tools still do", () => {
    // This fixture is from an SDK-driven run where the subagent's internal
    // steps never appear in the parent transcript at all (only the Task
    // call and its final tool_result do) — so there is nothing to tag
    // sub-start/sub-stop onto; the correct outcome is that the Task call
    // produces *no* tool card in either direction, while an unrelated,
    // ordinary tool (`Read`) still gets its normal visible `tool-start`.
    const rows = loadFixtureLines("task_sdk.jsonl");
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapAll(rows, state);

    const toolStarts = envelopes.filter((e) => e.ev.t === "tool-start");
    expect(toolStarts.every((e) => (e.ev.t === "tool-start" ? e.ev.name !== "Task" : true))).toBe(
      true,
    );
    expect(toolStarts.some((e) => (e.ev.t === "tool-start" ? e.ev.name === "Read" : false))).toBe(
      true,
    );
    // the Task's own tool_result must never surface as a tool-end either
    expect(envelopes.filter((e) => e.ev.t === "tool-end")).toHaveLength(0);
  });

  it("task_non_sdk.jsonl: infers the subagent chain purely from isSidechain/parentUuid + prompt matching", () => {
    const rows = loadFixtureLines("task_non_sdk.jsonl");
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapAll(rows, state);

    const subagentRoot = envelopes.find(
      (e) =>
        e.ev.t === "text" &&
        e.ev.md.startsWith("Search the web for information about TypeScript 5.6"),
    );
    expect(subagentRoot?.subagent).toBeDefined();
    expect(isCuid(subagentRoot!.subagent!)).toBe(true);
    expect(subagentRoot?.subagent).not.toBe("toolu_01EmKA8FJ7B2Ah9seGxK1Wct");

    const subagentChild = envelopes.find(
      (e) =>
        e.ev.t === "text" && e.ev.md.includes("I'll search for information about TypeScript 5.6"),
    );
    expect(subagentChild?.subagent).toBe(subagentRoot?.subagent);

    // the Task call itself must stay hidden
    expect(envelopes.some((e) => e.ev.t === "tool-start" && e.ev.name === "Task")).toBe(false);
  });

  it("model-change-session.jsonl: /model haiku invocation + local-command-stdout result maps to one clean service envelope (BF1.2)", () => {
    const rows = loadFixtureLines("model-change-session.jsonl");
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapAll(rows, state);

    // the invocation record is dropped entirely — only the stdout result
    // survives, as a single quiet service marker with no XML tags/ANSI codes.
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      role: "agent",
      ev: {
        t: "service",
        text: "Set model to Haiku 4.5 and saved as your default for new sessions.",
      },
    });
    const serviceText = envelopes[0]?.ev.t === "service" ? envelopes[0].ev.text : "";
    expect(serviceText).not.toMatch(/<command-name>|<local-command-stdout>/);
    expect(serviceText).not.toContain(String.fromCharCode(27));
  });

  it("permission-prompt-aborted-with-interrupt.jsonl: aborted tool_result maps to ok:false, no crash", () => {
    const rows = loadFixtureLines("permission-prompt-aborted-with-interrupt.jsonl");
    const state = createClaudeEnvelopeMapperState();
    const envelopes = mapAll(rows, state);

    const end = envelopes.find((e) => e.ev.t === "tool-end");
    expect(end?.ev).toMatchObject({ ok: false });
  });
});
