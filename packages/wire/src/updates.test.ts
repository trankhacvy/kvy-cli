import { describe, expect, it } from 'vitest';
import { EphemeralSchema, UpdateSchema } from './updates';

const box = { t: 'enc' as const, v: 1 as const, c: 'x' };

const sessionRow = {
  id: 'sess-1',
  accountId: 'acct-1',
  workspaceId: null,
  machineId: null,
  tag: 'main',
  provider: 'claude-code',
  executionTarget: 'local',
  status: 'active',
  metadata: { value: box, version: 0 },
  agentState: null,
  dek: 'sealed-dek',
  msgSeq: 0,
  createdAt: 1,
  updatedAt: 1,
};

describe('UpdateSchema', () => {
  it('accepts a structural update with a seq', () => {
    const update = { seq: 5, ts: Date.now(), body: { t: 'session-new', session: sessionRow } };
    expect(UpdateSchema.safeParse(update).success).toBe(true);
  });

  it('accepts a message-new update WITHOUT a seq (⚠ DELTA D2)', () => {
    const update = {
      ts: Date.now(),
      body: { t: 'message-new', sessionId: 'sess-1', msgSeq: 42, content: box },
    };
    const result = UpdateSchema.safeParse(update);
    expect(result.success).toBe(true);
  });

  it('accepts session-update with a partial patch', () => {
    const update = { seq: 6, ts: Date.now(), body: { t: 'session-update', id: 'sess-1', status: 'archived' } };
    expect(UpdateSchema.safeParse(update).success).toBe(true);
  });

  it('rejects an unknown body type', () => {
    const update = { ts: Date.now(), body: { t: 'not-a-real-update' } };
    expect(UpdateSchema.safeParse(update).success).toBe(false);
  });
});

describe('EphemeralSchema', () => {
  it('accepts activity/machine-presence/attention', () => {
    expect(EphemeralSchema.safeParse({ t: 'activity', sessionId: 's1', working: true }).success).toBe(true);
    expect(
      EphemeralSchema.safeParse({ t: 'machine-presence', machineId: 'm1', online: false }).success
    ).toBe(true);
    expect(EphemeralSchema.safeParse({ t: 'attention', sessionId: 's1', kind: 'perm' }).success).toBe(true);
  });

  it('rejects an unknown attention kind', () => {
    expect(EphemeralSchema.safeParse({ t: 'attention', sessionId: 's1', kind: 'urgent' }).success).toBe(false);
  });
});
