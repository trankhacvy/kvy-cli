import { describe, expect, it } from "vitest";
import { buildDiffFetchOptions } from "./git-diff-query";

describe("buildDiffFetchOptions", () => {
  it("returns no path/baseRef when both selectedPath and compareRef are null", () => {
    expect(buildDiffFetchOptions(null, null)).toEqual({});
  });

  it("sets path when selectedPath is given, leaving baseRef unset", () => {
    expect(buildDiffFetchOptions("src/a.ts", null)).toEqual({ path: "src/a.ts" });
  });

  it("sets baseRef when compareRef changes, leaving path unset", () => {
    expect(buildDiffFetchOptions(null, "main")).toEqual({ baseRef: "main" });
  });

  it("passes 'HEAD' through as an explicit baseRef override, same as any other ref", () => {
    expect(buildDiffFetchOptions(null, "HEAD")).toEqual({ baseRef: "HEAD" });
  });

  it("combines both when a file is selected under a non-default compare ref", () => {
    expect(buildDiffFetchOptions("src/a.ts", "main")).toEqual({
      path: "src/a.ts",
      baseRef: "main",
    });
  });

  it("re-derives fresh options when compareRef changes on an otherwise-unchanged selection — this is exactly what re-triggers the diff refetch (its queryKey includes compareRef)", () => {
    const before = buildDiffFetchOptions("src/a.ts", null);
    const after = buildDiffFetchOptions("src/a.ts", "release/1.0");
    expect(before).toEqual({ path: "src/a.ts" });
    expect(after).toEqual({ path: "src/a.ts", baseRef: "release/1.0" });
  });
});
