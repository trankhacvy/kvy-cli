import { describe, expect, it } from 'vitest';
import { decryptWithDataKey, encryptWithDataKey, getRandomBytes } from '../encryption.js';
import { decodeRecoveryCode, encodeRecoveryCode } from '../recovery.js';
import { open, seal } from '../box.js';
import { decodeBase64, encodeBase64 } from '../base64.js';
import { deriveKeyTree } from '../keys.js';

describe('edge cases: encryptWithDataKey / decryptWithDataKey', () => {
  it('decryptWithDataKey never throws on a dataKey of the wrong length', () => {
    const dek = getRandomBytes(32);
    const bundle = encryptWithDataKey({ x: 1 }, dek);
    const shortKey = getRandomBytes(16);
    const longKey = getRandomBytes(64);
    expect(() => decryptWithDataKey(bundle, shortKey)).not.toThrow();
    expect(decryptWithDataKey(bundle, shortKey)).toBeNull();
    expect(() => decryptWithDataKey(bundle, longKey)).not.toThrow();
    expect(decryptWithDataKey(bundle, longKey)).toBeNull();
  });

  it('round-trips empty object/array and zero-length string payloads', () => {
    const dek = getRandomBytes(32);
    for (const payload of [{}, [], '']) {
      const bundle = encryptWithDataKey(payload, dek);
      expect(decryptWithDataKey(bundle, dek)).toEqual(payload);
    }
  });

  it('large payload (100KB) round-trips', () => {
    const dek = getRandomBytes(32);
    const big = { blob: 'x'.repeat(100_000) };
    const bundle = encryptWithDataKey(big, dek);
    expect(decryptWithDataKey(bundle, dek)).toEqual(big);
  });
});

describe('edge cases: recovery code', () => {
  it('returns null for a base32 payload that decodes to the wrong byte length', () => {
    // 64 chars of valid base32 alphabet decodes to 40 bytes, not 32.
    const tooLong = 'A'.repeat(64);
    expect(decodeRecoveryCode(tooLong)).toBeNull();
  });

  it('encodeRecoveryCode -> decodeRecoveryCode is stable across many random secrets (fuzz)', () => {
    for (let i = 0; i < 100; i++) {
      const secret = getRandomBytes(32);
      expect(decodeRecoveryCode(encodeRecoveryCode(secret))).toEqual(secret);
    }
  });

  it('single bit flip in the recovery code either fails closed (null) or decodes to a different secret, never the original', () => {
    const secret = getRandomBytes(32);
    const code = encodeRecoveryCode(secret);
    // Flip one alphanumeric character in the middle of the code to a different valid base32 char.
    const chars = code.split('');
    const idx = chars.findIndex((c) => c !== '-');
    const original = chars[idx]!;
    chars[idx] = original === 'A' ? 'B' : 'A';
    const mutated = chars.join('');
    const decoded = decodeRecoveryCode(mutated);
    if (decoded !== null) {
      expect(decoded).not.toEqual(secret);
    }
  });
});

describe('edge cases: EncryptedBox seal/open', () => {
  it('seal() throws synchronously on a malformed (non-32-byte) dek rather than silently producing a broken box', () => {
    const shortDek = getRandomBytes(16);
    expect(() => seal({ a: 1 }, shortDek)).toThrow();
  });

  it('open() does not validate box.v/box.t — decrypts purely off box.c (documented convention, not enforced here)', () => {
    const dek = getRandomBytes(32);
    const box = seal({ a: 1 }, dek);
    const wrongVersionBox = { ...box, v: 999 as unknown as 1 };
    // Currently succeeds because open() ignores v/t and only looks at c.
    expect(open(wrongVersionBox, dek)).toEqual({ a: 1 });
  });
});

describe('edge cases: base64', () => {
  it('decodeBase64 silently drops characters outside the given variant\'s alphabet instead of erroring', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251]);
    const urlEncoded = encodeBase64(bytes, 'base64url');
    // Decoding a base64url string with the default 'base64' variant will silently
    // drop any '-'/'_' characters present, which can silently produce wrong bytes
    // instead of failing. Only meaningful when the encoding actually needed '-'/'_'.
    if (urlEncoded.includes('-') || urlEncoded.includes('_')) {
      const wronglyDecoded = decodeBase64(urlEncoded); // default variant
      expect(wronglyDecoded).not.toEqual(bytes);
    }
  });
});

describe('edge cases: deriveKeyTree', () => {
  it('all-zero masterSecret does not crash and produces a valid tree', () => {
    const tree = deriveKeyTree(new Uint8Array(32));
    expect(tree.signing.publicKey.length).toBe(32);
    expect(tree.content.publicKey.length).toBe(32);
    expect(tree.anonId).toMatch(/^[0-9a-f]{16}$/);
  });
});
