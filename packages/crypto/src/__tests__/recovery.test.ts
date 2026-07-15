import { describe, expect, it } from 'vitest';
import { decodeRecoveryCode, encodeRecoveryCode } from '../recovery.js';
import { getRandomBytes } from '../encryption.js';

describe('recovery code (grouped Base32)', () => {
  it('round-trips a random 32-byte masterSecret', () => {
    for (let i = 0; i < 20; i++) {
      const secret = getRandomBytes(32);
      const code = encodeRecoveryCode(secret);
      expect(decodeRecoveryCode(code)).toEqual(secret);
    }
  });

  it('is grouped into dash-separated chunks of up to 5 chars', () => {
    const code = encodeRecoveryCode(getRandomBytes(32));
    const groups = code.split('-');
    expect(groups.length).toBe(11);
    for (const g of groups) expect(g.length).toBeLessThanOrEqual(5);
  });

  it('decodes case-insensitively and tolerates stray whitespace', () => {
    const secret = getRandomBytes(32);
    const code = encodeRecoveryCode(secret);
    expect(decodeRecoveryCode(code.toLowerCase())).toEqual(secret);
    expect(decodeRecoveryCode(`  ${code}  `.replaceAll('-', ' - '))).toEqual(secret);
  });

  it('normalizes common typos: 0->O, 1->I, 8->B, 9->G', () => {
    const secret = getRandomBytes(32);
    const code = encodeRecoveryCode(secret);
    // Only meaningful if the code actually contains a letter that could be typo'd;
    // verify the normalization functions don't corrupt a code that has none, and
    // separately verify the substitution table directly.
    expect(decodeRecoveryCode(code)).toEqual(secret);

    const withTypos = code.replaceAll('O', '0').replaceAll('I', '1').replaceAll('B', '8').replaceAll('G', '9');
    expect(decodeRecoveryCode(withTypos)).toEqual(secret);
  });

  it('returns null (never throws) on garbage input', () => {
    expect(() => decodeRecoveryCode('not a real code')).not.toThrow();
    expect(decodeRecoveryCode('')).toBeNull();
    expect(decodeRecoveryCode('!!!---###')).toBeNull();
  });

  it('returns null when decoded length is not exactly 32 bytes', () => {
    expect(decodeRecoveryCode('ABCDE')).toBeNull(); // way too short
  });
});
