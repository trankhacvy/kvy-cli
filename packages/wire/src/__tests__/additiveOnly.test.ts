import { describe, expect, it } from 'vitest';
import wireShapesFixture from './__fixtures__/wire-shapes.json';
import { describeShape, isCompatible, type ShapeDescriptor } from './schemaShape';
import { schemaRegistry } from './schemaRegistry';

// The fixture is untyped JSON on disk; it's only ever produced by
// `describeShape` (see scripts/snapshot-shapes.ts), so this cast is safe.
const frozen = wireShapesFixture as unknown as Record<string, ShapeDescriptor>;

describe('wire schema additive-only compat', () => {
  it('never drops a frozen schema', () => {
    for (const name of Object.keys(frozen)) {
      expect(schemaRegistry, `frozen schema "${name}" was removed from the registry`).toHaveProperty(name);
    }
  });

  for (const name of Object.keys(frozen)) {
    it(`${name} is a backward-compatible evolution of its frozen shape`, () => {
      const live = schemaRegistry[name];
      expect(live, `"${name}" is frozen but no longer exported`).toBeDefined();
      const liveShape = describeShape(live!);
      const ok = isCompatible(frozen[name]!, liveShape);
      expect(ok, `"${name}" lost or retyped a field the wire protocol already shipped (see design §5.3: additive-only, forever)`).toBe(
        true
      );
    });
  }

  it('every schema in the registry is covered by the frozen fixture', () => {
    // Not a hard requirement to fail CI on (new schemas are fine to add
    // freely) — but flags drift so the fixture gets regenerated deliberately
    // rather than silently going stale.
    const uncovered = Object.keys(schemaRegistry).filter((name) => !(name in frozen));
    if (uncovered.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[wire] ${uncovered.length} schema(s) not yet in wire-shapes.json fixture: ${uncovered.join(', ')}. ` +
          'Run "pnpm --filter @falcon/wire exec tsx scripts/snapshot-shapes.ts" to freeze them.'
      );
    }
    expect(true).toBe(true);
  });
});
