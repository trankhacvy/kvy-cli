import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SessionEnvelopeSchema } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import { reduceEnvelopes } from "./reduce.js";

/**
 * Golden-trace reducer tests (plan.md §8.2, §14.1; falcon-system-design.md
 * §9.1, §13): every `__testdata__/trace_*.json` fixture pairs a recorded (or
 * hand-built, representative) `SessionEnvelope[]` with the exact
 * `RenderItem[]` the reducer must produce for it. This is Happy's
 * `trace_*.json` convention, ported — grow this directory with every new
 * provider quirk found, per plan.md's cross-cutting rule.
 */

const testdataDir = path.join(import.meta.dirname, "__testdata__");

interface TraceFixture {
  description: string;
  envelopes: unknown[];
  expected: unknown[];
}

const fixtureFiles = readdirSync(testdataDir).filter((f) => /^trace_.*\.json$/.test(f));

describe("reduceEnvelopes — golden traces", () => {
  it("finds at least one trace_*.json fixture", () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  for (const file of fixtureFiles) {
    it(`${file} matches its recorded render tree`, () => {
      const raw = JSON.parse(readFileSync(path.join(testdataDir, file), "utf8")) as TraceFixture;

      // Fixtures must themselves be valid wire envelopes — a malformed
      // fixture is a bug in the test, not something to silently skip.
      const envelopes = raw.envelopes.map((e) => SessionEnvelopeSchema.parse(e));

      const actual = reduceEnvelopes(envelopes);
      expect(actual).toEqual(raw.expected);
    });
  }
});
