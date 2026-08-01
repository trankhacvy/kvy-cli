import { describe, expect, it } from "vitest";
import { mockFileMentionActions } from "../mock-source";

describe("mockFileMentionActions", () => {
  it("search('') returns a non-empty default set", async () => {
    const results = await mockFileMentionActions.search("");
    expect(results.length).toBeGreaterThan(0);
  });

  it("finds the two example files kvy-prd.md's own copy calls out", async () => {
    const claude = await mockFileMentionActions.search("CLAUDE.md");
    expect(claude.map((r) => r.path)).toContain("CLAUDE.md");

    const pkg = await mockFileMentionActions.search("package.json");
    expect(pkg.map((r) => r.path)).toContain("package.json");
  });

  it("returns nothing for a query that matches no real path", async () => {
    const results = await mockFileMentionActions.search("zzz-not-a-real-file-zzz");
    expect(results).toEqual([]);
  });

  it("every returned path is a relative path (never starts with '/')", async () => {
    const results = await mockFileMentionActions.search("");
    for (const entry of results) {
      expect(entry.path.startsWith("/")).toBe(false);
    }
  });
});
