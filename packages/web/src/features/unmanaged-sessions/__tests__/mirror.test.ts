import { describe, expect, it } from "vitest";
import { fetchFullTranscript, parseMirrorLines } from "../mirror";

describe("fetchFullTranscript", () => {
  it("concatenates chunks until done:true", async () => {
    const calls: Array<number | undefined> = [];
    const mirror = async (_id: string, cursor?: number) => {
      calls.push(cursor);
      if (cursor === undefined) return { chunk: "a", nextCursor: 1, done: false };
      if (cursor === 1) return { chunk: "b", nextCursor: 2, done: false };
      return { chunk: "c", nextCursor: null, done: true };
    };

    const text = await fetchFullTranscript({ mirror }, "prov-1");
    expect(text).toBe("abc");
    expect(calls).toEqual([undefined, 1, 2]);
  });

  it("stops when nextCursor is null even if done is false", async () => {
    const mirror = async () => ({ chunk: "only", nextCursor: null, done: false });
    const text = await fetchFullTranscript({ mirror }, "prov-1");
    expect(text).toBe("only");
  });

  it("returns the empty string for a single done:true chunk with no content", async () => {
    const mirror = async () => ({ chunk: "", nextCursor: null, done: true });
    const text = await fetchFullTranscript({ mirror }, "prov-1");
    expect(text).toBe("");
  });

  it("throws rather than looping forever when the daemon never reports done", async () => {
    let n = 0;
    const mirror = async () => {
      n += 1;
      return { chunk: "x", nextCursor: n, done: false };
    };
    await expect(fetchFullTranscript({ mirror }, "prov-1")).rejects.toThrow(/did not finish/);
  });
});

describe("parseMirrorLines", () => {
  it("extracts user and assistant text entries", () => {
    const transcript = [
      JSON.stringify({ type: "user", message: { content: "hello there" } }),
      JSON.stringify({ type: "assistant", message: { content: "hi, how can I help?" } }),
    ].join("\n");

    expect(parseMirrorLines(transcript)).toEqual([
      { kind: "user", text: "hello there" },
      { kind: "agent", text: "hi, how can I help?" },
    ]);
  });

  it("extracts the first text block from an array content field", () => {
    const transcript = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", text: "..." },
          { type: "text", text: "the answer" },
        ],
      },
    });
    expect(parseMirrorLines(transcript)).toEqual([{ kind: "agent", text: "the answer" }]);
  });

  it("falls back to a raw line for unparsable JSON", () => {
    const transcript = "not json at all";
    expect(parseMirrorLines(transcript)).toEqual([{ kind: "raw", text: "not json at all" }]);
  });

  it("falls back to a raw line for a recognized type with no extractable text", () => {
    const transcript = JSON.stringify({ type: "user", message: { content: [] } });
    expect(parseMirrorLines(transcript)).toEqual([{ kind: "raw", text: transcript }]);
  });

  it("skips blank lines and ignores unrecognized entry types as raw", () => {
    const transcript = ["", "  ", JSON.stringify({ type: "summary", summary: "Title" })].join("\n");
    expect(parseMirrorLines(transcript)).toEqual([
      { kind: "raw", text: JSON.stringify({ type: "summary", summary: "Title" }) },
    ]);
  });
});
