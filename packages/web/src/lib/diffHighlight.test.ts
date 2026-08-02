import { describe, expect, it } from "vitest";
import { highlightDiffLines, languageForPath } from "./diffHighlight";

describe("languageForPath", () => {
  it("maps common extensions to shiki language ids", () => {
    expect(languageForPath("src/a.ts")).toBe("typescript");
    expect(languageForPath("src/a.tsx")).toBe("tsx");
    expect(languageForPath("scripts/run.py")).toBe("python");
    expect(languageForPath("README.md")).toBe("markdown");
    expect(languageForPath("Dockerfile.dockerfile")).toBe("docker");
  });

  it("falls back to plaintext for an unknown or missing extension", () => {
    expect(languageForPath("LICENSE")).toBe("plaintext");
    expect(languageForPath("src/thing.unknownext")).toBe("plaintext");
    expect(languageForPath(".gitignore")).toBe("plaintext");
  });

  it("handles nested paths, using only the final path segment", () => {
    expect(languageForPath("packages/web/src/lib/diff.ts")).toBe("typescript");
  });
});

describe("highlightDiffLines", () => {
  it("returns one token row per input line, preserving the joined text", async () => {
    const lines = ["const x: number = 1;", "const y = x + 1;"];
    const tokens = await highlightDiffLines(lines, "typescript");

    expect(tokens).toHaveLength(2);
    for (let i = 0; i < lines.length; i++) {
      const lineText = (tokens[i] ?? []).map((t) => t.content).join("");
      expect(lineText).toBe(lines[i]);
    }
    // Real shiki tokenization of a `const` declaration produces more than
    // one token per line (keyword vs identifier vs punctuation) — this is
    // the assertion that highlighting is actually happening, not just
    // passing text through.
    expect(tokens[0]?.length ?? 0).toBeGreaterThan(1);
  });

  it("returns an empty array for no lines", async () => {
    expect(await highlightDiffLines([], "typescript")).toEqual([]);
  });

  it("falls back to unhighlighted plain tokens for plaintext, still preserving content", async () => {
    const lines = ["just some text", "more text here"];
    const tokens = await highlightDiffLines(lines, "plaintext");

    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.map((t) => t.content).join("")).toBe(lines[0]);
    expect(tokens[1]?.map((t) => t.content).join("")).toBe(lines[1]);
  });

  it("handles an empty line among non-empty ones without losing alignment", async () => {
    const lines = ["const a = 1;", "", "const b = 2;"];
    const tokens = await highlightDiffLines(lines, "typescript");

    expect(tokens).toHaveLength(3);
    expect(tokens[1]?.map((t) => t.content).join("")).toBe("");
  });
});
