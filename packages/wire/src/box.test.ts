import { describe, expect, it } from 'vitest';
import { EncryptedBoxSchema, VersionedSchema } from './box';

describe('EncryptedBoxSchema', () => {
  it('accepts a well-formed box', () => {
    const box = { t: 'enc' as const, v: 1 as const, c: 'YmFzZTY0' };
    expect(EncryptedBoxSchema.safeParse(box).success).toBe(true);
  });

  it('rejects a wrong discriminator or version', () => {
    expect(EncryptedBoxSchema.safeParse({ t: 'plain', v: 1, c: 'x' }).success).toBe(false);
    expect(EncryptedBoxSchema.safeParse({ t: 'enc', v: 2, c: 'x' }).success).toBe(false);
    expect(EncryptedBoxSchema.safeParse({ t: 'enc', v: 1 }).success).toBe(false);
  });
});

describe('VersionedSchema', () => {
  it('wraps an inner schema with a version counter', () => {
    const schema = VersionedSchema(EncryptedBoxSchema);
    const value = { value: { t: 'enc' as const, v: 1 as const, c: 'x' }, version: 3 };
    expect(schema.safeParse(value).success).toBe(true);
    expect(schema.safeParse({ value: value.value }).success).toBe(false); // version required
  });
});
