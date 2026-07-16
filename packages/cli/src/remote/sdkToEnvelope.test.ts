import { describe, expect, it } from "vitest";
import { SdkToEnvelopeConverter } from "./sdkToEnvelope.js";

describe("SdkToEnvelopeConverter", () => {
  it("maps an assistant text block to a text envelope and opens a turn", () => {
    const converter = new SdkToEnvelopeConverter();
    const envelopes = converter.convert({
      type: "assistant",
      uuid: "a-1",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });

    expect(envelopes.map((e) => e.ev.t)).toEqual(["turn-start", "text"]);
    const text = envelopes[1];
    expect(text?.ev).toMatchObject({ t: "text", md: "hello" });
  });

  it("maps a thinking block to a text envelope with thinking:true", () => {
    const converter = new SdkToEnvelopeConverter();
    const envelopes = converter.convert({
      type: "assistant",
      uuid: "a-1",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
    });

    const text = envelopes.find((e) => e.ev.t === "text");
    expect(text?.ev).toMatchObject({ t: "text", md: "hmm", thinking: true });
  });

  it("maps a non-Task tool_use block to a tool-start envelope", () => {
    const converter = new SdkToEnvelopeConverter();
    const envelopes = converter.convert({
      type: "assistant",
      uuid: "a-1",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
      },
    });

    const toolStart = envelopes.find((e) => e.ev.t === "tool-start");
    expect(toolStart?.ev).toMatchObject({ t: "tool-start", name: "Bash" });
  });

  it("maps a subprocess tool_result user message to a tool-end envelope", () => {
    const converter = new SdkToEnvelopeConverter();
    converter.convert({
      type: "assistant",
      uuid: "a-1",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
      },
    });

    const envelopes = converter.convert({
      type: "user",
      uuid: "u-1",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }],
      },
    });

    expect(envelopes.map((e) => e.ev.t)).toEqual(["tool-end"]);
    expect(envelopes[0]?.ev).toMatchObject({ t: "tool-end", ok: true });
  });

  it("ignores a plain-string-content user message (emitted directly by claudeRemote.ts's send() instead)", () => {
    const converter = new SdkToEnvelopeConverter();
    const envelopes = converter.convert({
      type: "user",
      uuid: "u-1",
      parent_tool_use_id: null,
      message: { role: "user", content: "hi there" },
    });
    expect(envelopes).toEqual([]);
  });

  it("ignores stream_event (partial assistant) messages entirely", () => {
    const converter = new SdkToEnvelopeConverter();
    const envelopes = converter.convert({
      type: "stream_event",
      uuid: "s-1",
      parent_tool_use_id: null,
      event: { type: "content_block_delta" },
    });
    expect(envelopes).toEqual([]);
  });

  it("a result message closes the open turn as completed", () => {
    const converter = new SdkToEnvelopeConverter();
    converter.convert({
      type: "assistant",
      uuid: "a-1",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });

    const envelopes = converter.convert({ type: "result", subtype: "success", is_error: false });
    expect(envelopes).toEqual([expect.objectContaining({ ev: { t: "turn-end", status: "completed" } })]);
  });

  it("a result message with is_error closes the open turn as failed", () => {
    const converter = new SdkToEnvelopeConverter();
    converter.convert({
      type: "assistant",
      uuid: "a-1",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });

    const envelopes = converter.convert({ type: "result", subtype: "error", is_error: true });
    expect(envelopes).toEqual([expect.objectContaining({ ev: { t: "turn-end", status: "failed" } })]);
  });

  it("a result message with no open turn produces no envelopes", () => {
    const converter = new SdkToEnvelopeConverter();
    const envelopes = converter.convert({ type: "result", subtype: "success", is_error: false });
    expect(envelopes).toEqual([]);
  });

  it("closeTurn() force-closes an in-progress turn (e.g. on interrupt)", () => {
    const converter = new SdkToEnvelopeConverter();
    converter.convert({
      type: "assistant",
      uuid: "a-1",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });

    const envelopes = converter.closeTurn("cancelled");
    expect(envelopes).toEqual([expect.objectContaining({ ev: { t: "turn-end", status: "cancelled" } })]);
  });
});
