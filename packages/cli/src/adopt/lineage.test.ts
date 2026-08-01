import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAdoptionLineage, recordAdoptionLineage } from "./lineage.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "kvy-lineage-test-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("recordAdoptionLineage / getAdoptionLineage", () => {
  it("returns null for a session that was never adopted", async () => {
    expect(await getAdoptionLineage("old-1", { homeDir })).toBeNull();
  });

  it("records a fresh one-hop chain and reads it back", async () => {
    const chain = await recordAdoptionLineage("old-1", "new-1", { homeDir });
    expect(chain).toEqual(["old-1", "new-1"]);
    expect(await getAdoptionLineage("old-1", { homeDir })).toEqual(["old-1", "new-1"]);
  });

  it("appends a second hop onto an existing chain", async () => {
    await recordAdoptionLineage("old-1", "new-1", { homeDir });
    const chain = await recordAdoptionLineage("old-1", "new-2", { homeDir });
    expect(chain).toEqual(["old-1", "new-1", "new-2"]);
  });

  it("is idempotent — recording the same hop twice doesn't duplicate it", async () => {
    await recordAdoptionLineage("old-1", "new-1", { homeDir });
    const chain = await recordAdoptionLineage("old-1", "new-1", { homeDir });
    expect(chain).toEqual(["old-1", "new-1"]);
  });

  it("keeps chains for different original sessions independent", async () => {
    await recordAdoptionLineage("old-1", "new-1", { homeDir });
    await recordAdoptionLineage("old-2", "new-2", { homeDir });
    expect(await getAdoptionLineage("old-1", { homeDir })).toEqual(["old-1", "new-1"]);
    expect(await getAdoptionLineage("old-2", { homeDir })).toEqual(["old-2", "new-2"]);
  });

  it("extends the original chain across 3+ adoption generations, matching the real `kvy adopt` call pattern (each call keyed on the most-recently-active transcript, not the original root)", async () => {
    // Real invocation pattern: `commands/adopt.ts` always passes
    // `listAdoptableSessions()`'s pick as `old`, which is B after the
    // first adopt, C after the second, etc. — never the original root A.
    const chain1 = await recordAdoptionLineage("A", "B", { homeDir });
    expect(chain1).toEqual(["A", "B"]);

    const chain2 = await recordAdoptionLineage("B", "C", { homeDir });
    expect(chain2).toEqual(["A", "B", "C"]);

    const chain3 = await recordAdoptionLineage("C", "D", { homeDir });
    expect(chain3).toEqual(["A", "B", "C", "D"]);

    // Full history must be reconstitutable from the original root id...
    expect(await getAdoptionLineage("A", { homeDir })).toEqual(["A", "B", "C", "D"]);
    // ...and from any later hop, since callers may only know the most
    // recent id.
    expect(await getAdoptionLineage("C", { homeDir })).toEqual(["A", "B", "C", "D"]);
  });
});
