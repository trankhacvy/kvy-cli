import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SessionEnvelopeSchema } from "@kvy/wire";
import { describe, expect, it } from "vitest";
import { reduceEnvelopes } from "./reduce.js";

/**
 * hand-built, representative) `SessionEnvelope[]` with the exact
 * `trace_*.json` convention, ported — grow this directory with every new
 *
 * ACP `session/update` → `SessionEnvelope` mapping needs no new `@kvy/wire`
 * envelope types: each fixture models the envelopes the future
 * `acpToEnvelope` mapper (Phase 2.1) will emit for a given ACP update kind,
 * built entirely from variants `SessionEventSchema` already defines, and
 * proves — by parsing and reducing successfully like every other fixture
 * here — that the existing schema is sufficient.
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
