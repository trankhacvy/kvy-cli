import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./unifiedDiff";

describe("parseUnifiedDiff", () => {
  it("parses a single modified file with one hunk", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index aaaa..bbbb 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " line one",
      "-line two",
      "+line two edited",
      "+line new",
      " line three",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diff);

    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0]!;
    expect(file.path).toBe("src/a.ts");
    expect(file.oldPath).toBe("src/a.ts");
    expect(file.newPath).toBe("src/a.ts");
    expect(file.binary).toBe(false);
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0]!;
    expect(hunk.header).toBe("@@ -1,3 +1,4 @@");
    expect(hunk.lines).toEqual([
      { type: "context", content: "line one", oldLine: 1, newLine: 1 },
      { type: "remove", content: "line two", oldLine: 2, newLine: null },
      { type: "add", content: "line two edited", oldLine: null, newLine: 2 },
      { type: "add", content: "line new", oldLine: null, newLine: 3 },
      { type: "context", content: "line three", oldLine: 3, newLine: 4 },
    ]);
  });

  it("parses multiple files in one diff", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,1 +1,1 @@",
      "-foo",
      "+bar",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diff);
    expect(parsed.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parsed.files[0]!.hunks[0]!.lines).toHaveLength(2);
    expect(parsed.files[1]!.hunks[0]!.lines).toHaveLength(2);
  });

  it("handles a newly added file (oldPath is /dev/null)", () => {
    const diff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..aaaa",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+second",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0]!;
    expect(file.oldPath).toBeNull();
    expect(file.newPath).toBe("src/new.ts");
    expect(file.path).toBe("src/new.ts");
    expect(file.hunks[0]!.lines.every((l) => l.type === "add")).toBe(true);
  });

  it("handles a deleted file (newPath is /dev/null), displaying oldPath", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-first",
      "-second",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0]!;
    expect(file.oldPath).toBe("src/old.ts");
    expect(file.newPath).toBeNull();
    expect(file.path).toBe("src/old.ts");
  });

  it("marks a binary file diff and produces no hunks", () => {
    const diff = [
      "diff --git a/assets/logo.png b/assets/logo.png",
      "index aaaa..bbbb 100644",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0]!;
    expect(file.binary).toBe(true);
    expect(file.hunks).toEqual([]);
  });

  it("ignores a trailing '\\ No newline at end of file' marker", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diff);
    expect(parsed.files[0]!.hunks[0]!.lines).toEqual([
      { type: "remove", content: "old", oldLine: 1, newLine: null },
      { type: "add", content: "new", oldLine: null, newLine: 1 },
    ]);
  });

  it("parses multiple hunks within one file, tracking line numbers per hunk", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-a",
      "+b",
      " c",
      "@@ -10,2 +10,3 @@",
      " d",
      "+e",
      " f",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0]!;
    expect(file.hunks).toHaveLength(2);
    expect(file.hunks[1]!.lines[0]).toEqual({
      type: "context",
      content: "d",
      oldLine: 10,
      newLine: 10,
    });
  });

  it("returns no files for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual({ files: [] });
  });

  it("handles a blank context line (empty line in the source file, prefixed with a single space) without dropping it", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " line one",
      " ",
      " line three",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(diff);
    expect(parsed.files[0]!.hunks[0]!.lines).toEqual([
      { type: "context", content: "line one", oldLine: 1, newLine: 1 },
      { type: "context", content: "", oldLine: 2, newLine: 2 },
      { type: "context", content: "line three", oldLine: 3, newLine: 3 },
    ]);
  });
});
