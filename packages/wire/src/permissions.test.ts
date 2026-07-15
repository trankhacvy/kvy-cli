import { describe, expect, it } from 'vitest';
import { PermDecisionSchema, PermissionModeSchema } from './permissions';

describe('PermissionModeSchema', () => {
  it('accepts the four known modes', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) {
      expect(PermissionModeSchema.safeParse(mode).success).toBe(true);
    }
  });

  it('rejects an unknown mode', () => {
    expect(PermissionModeSchema.safeParse('yolo').success).toBe(false);
  });
});

describe('PermDecisionSchema', () => {
  it('accepts allow/deny/mode variants', () => {
    expect(PermDecisionSchema.safeParse({ kind: 'allow', scope: 'once' }).success).toBe(true);
    expect(PermDecisionSchema.safeParse({ kind: 'allow', scope: 'session', updatedInput: { foo: 1 } }).success).toBe(
      true
    );
    expect(PermDecisionSchema.safeParse({ kind: 'deny' }).success).toBe(true);
    expect(PermDecisionSchema.safeParse({ kind: 'deny', message: 'no' }).success).toBe(true);
    expect(PermDecisionSchema.safeParse({ kind: 'mode', mode: 'plan' }).success).toBe(true);
  });

  it('rejects malformed decisions', () => {
    expect(PermDecisionSchema.safeParse({ kind: 'allow', scope: 'forever' }).success).toBe(false);
    expect(PermDecisionSchema.safeParse({ kind: 'mode', mode: 'yolo' }).success).toBe(false);
    expect(PermDecisionSchema.safeParse({ kind: 'unknown' }).success).toBe(false);
  });
});
