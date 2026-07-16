import { describe, expect, it } from "vitest";
import { diffLines } from "./diff";

describe("diffLines", () => {
  it("returns all-context lines for identical text", () => {
    const lines = diffLines("a\nb\nc", "a\nb\nc");
    expect(lines).toEqual([
      { type: "context", text: "a" },
      { type: "context", text: "b" },
      { type: "context", text: "c" },
    ]);
  });

  it("treats an empty old string as a pure addition", () => {
    const lines = diffLines("", "one\ntwo");
    expect(lines).toEqual([
      { type: "add", text: "one" },
      { type: "add", text: "two" },
    ]);
  });

  it("treats an empty new string as a pure removal", () => {
    const lines = diffLines("one\ntwo", "");
    expect(lines).toEqual([
      { type: "remove", text: "one" },
      { type: "remove", text: "two" },
    ]);
  });

  it("aligns a single changed line in the middle, keeping context around it", () => {
    const lines = diffLines("a\nb\nc", "a\nB\nc");
    expect(lines).toEqual([
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "B" },
      { type: "context", text: "c" },
    ]);
  });

  it("handles a pure insertion in the middle", () => {
    const lines = diffLines("a\nc", "a\nb\nc");
    expect(lines).toEqual([
      { type: "context", text: "a" },
      { type: "add", text: "b" },
      { type: "context", text: "c" },
    ]);
  });

  it("falls back to remove-all/add-all when the LCS table would be too large", () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line-${i}`).join("\n");
    const bigChanged = Array.from({ length: 2500 }, (_, i) => `line-${i}-x`).join("\n");
    const lines = diffLines(big, bigChanged);

    expect(lines.filter((l) => l.type === "remove")).toHaveLength(2500);
    expect(lines.filter((l) => l.type === "add")).toHaveLength(2500);
    expect(lines.every((l) => l.type !== "context")).toBe(true);
  });

  it("never drops a line — total output covers every input line at least once", () => {
    const lines = diffLines("x\ny", "y\nz");
    const removed = lines.filter((l) => l.type === "remove").map((l) => l.text);
    const added = lines.filter((l) => l.type === "add").map((l) => l.text);
    const kept = lines.filter((l) => l.type === "context").map((l) => l.text);
    expect([...removed, ...kept]).toEqual(expect.arrayContaining(["x", "y"]));
    expect([...added, ...kept]).toEqual(expect.arrayContaining(["y", "z"]));
  });
});
