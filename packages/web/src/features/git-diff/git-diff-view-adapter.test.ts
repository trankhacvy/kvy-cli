import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@/lib/unifiedDiff";
import { buildDiffViewHunks, serializeHunk } from "./git-diff-view-adapter";

const RAW_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " unchanged",
  "-removed line",
  "+added line",
  " tail",
  "",
].join("\n");

describe("serializeHunk", () => {
  it("re-serializes a parsed hunk back into raw @@ header + prefixed-line text", () => {
    const parsed = parseUnifiedDiff(RAW_DIFF);
    const hunk = parsed.files[0]?.hunks[0];
    if (!hunk) throw new Error("expected a parsed hunk");

    expect(serializeHunk(hunk)).toBe(
      ["@@ -1,3 +1,3 @@", " unchanged", "-removed line", "+added line", " tail"].join("\n"),
    );
  });
});

describe("buildDiffViewHunks", () => {
  it("returns one raw-text string per hunk, in order", () => {
    const parsed = parseUnifiedDiff(RAW_DIFF);
    const file = parsed.files[0];
    if (!file) throw new Error("expected a parsed file");

    const hunks = buildDiffViewHunks(file);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toContain("@@ -1,3 +1,3 @@");
    expect(hunks[0]).toContain("+added line");
  });

  it("returns an empty array for a binary file (no hunks)", () => {
    const binaryDiff = [
      "diff --git a/img.png b/img.png",
      "index 1111111..2222222 100644",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n");
    const parsed = parseUnifiedDiff(binaryDiff);
    const file = parsed.files[0];
    if (!file) throw new Error("expected a parsed file");

    expect(file.binary).toBe(true);
    expect(buildDiffViewHunks(file)).toEqual([]);
  });

  it("round-trips a multi-hunk file's line count", () => {
    const multiHunkDiff = [
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,2 +1,2 @@",
      "-old top",
      "+new top",
      " ctx",
      "@@ -10,2 +10,2 @@",
      "-old bottom",
      "+new bottom",
      " ctx2",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(multiHunkDiff);
    const file = parsed.files[0];
    if (!file) throw new Error("expected a parsed file");

    const hunks = buildDiffViewHunks(file);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toContain("old top");
    expect(hunks[1]).toContain("old bottom");
  });
});
