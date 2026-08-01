/**
 * Regenerates `src/__tests__/__fixtures__/wire-shapes.json` from the current
 * schema registry. Run this ONLY when deliberately freezing a new/changed
 * schema shape — the additive-only test (`additiveOnly.test.ts`) diffs the
 * live schemas against this fixture on every run, so regenerating it is how
 * you tell CI "these fields are now the frozen baseline."
 *
 * Usage: pnpm --filter @kvy/wire exec tsx scripts/snapshot-shapes.ts
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schemaRegistry } from "../src/__tests__/schemaRegistry";
import { describeShape } from "../src/__tests__/schemaShape";

const out: Record<string, unknown> = {};
for (const [name, schema] of Object.entries(schemaRegistry)) {
  out[name] = describeShape(schema);
}

const target = fileURLToPath(
  new URL("../src/__tests__/__fixtures__/wire-shapes.json", import.meta.url),
);
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`Wrote ${Object.keys(out).length} schema shapes to ${target}`);
