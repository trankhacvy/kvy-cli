import { describe, expect, it } from "vitest";
import { filterFileMentions } from "../fuzzy";
import type { FileMentionEntry } from "../types";

function paths(entries: FileMentionEntry[]): string[] {
  return entries.map((e) => e.path);
}

const FILES: FileMentionEntry[] = [
  { path: "CLAUDE.md" },
  { path: "package.json" },
  { path: "packages/web/src/components/timeline/Composer.tsx" },
  { path: "packages/web/src/components/timeline/ComposerControls.tsx" },
  { path: "packages/cli/src/daemon/machineRpc.ts" },
  { path: "packages/wire/package.json" },
];

describe("filterFileMentions", () => {
  it("returns the first `limit` entries unscored for an empty query", () => {
    expect(filterFileMentions(FILES, "", 3)).toEqual(FILES.slice(0, 3));
  });

  it("finds a case-insensitive exact substring match", () => {
    expect(paths(filterFileMentions(FILES, "claude"))).toEqual(["CLAUDE.md"]);
  });

  it("matches as a subsequence, not just a substring — 'cmpsr' still finds Composer.tsx", () => {
    const results = paths(filterFileMentions(FILES, "cmpsr"));
    expect(results).toContain("packages/web/src/components/timeline/Composer.tsx");
  });

  it("ranks an exact/shorter match above a longer fuzzy one for an ambiguous query", () => {
    // "package.json" is an exact substring match; "packages/wire/package.json"
    // also contains it but is longer — the shorter one should rank first.
    const results = paths(filterFileMentions(FILES, "package.json"));
    expect(results[0]).toBe("package.json");
  });

  it("prefers the shorter path (Composer.tsx) over the longer one (ComposerControls.tsx) for the same query", () => {
    const results = paths(filterFileMentions(FILES, "composer"));
    expect(results[0]).toBe("packages/web/src/components/timeline/Composer.tsx");
  });

  it("drops entries that don't match at all", () => {
    const results = filterFileMentions(FILES, "zzz-does-not-exist");
    expect(results).toEqual([]);
  });

  it("respects the `limit` argument", () => {
    expect(filterFileMentions(FILES, "a", 2)).toHaveLength(2);
  });
});
