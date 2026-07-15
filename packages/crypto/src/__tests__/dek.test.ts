import { describe, expect, it } from 'vitest';
import { unwrapDek, wrapDek } from '../dek.js';
import { deriveKeyTree } from '../keys.js';
import { getRandomBytes } from '../encryption.js';

describe('wrapDek / unwrapDek', () => {
  it('round-trips a DEK sealed to a content keypair', () => {
    const tree = deriveKeyTree(getRandomBytes(32));
    const dek = getRandomBytes(32);
    const wrapped = wrapDek(dek, tree.content.publicKey);
    expect(unwrapDek(wrapped, tree.content.secretKey)).toEqual(dek);
  });

  it('version byte is 0x00', () => {
    const tree = deriveKeyTree(getRandomBytes(32));
    const wrapped = wrapDek(getRandomBytes(32), tree.content.publicKey);
    expect(wrapped[0]).toBe(0x00);
  });

  it('unwrapDek returns null (never throws) on wrong content secret key', () => {
    const treeA = deriveKeyTree(getRandomBytes(32));
    const treeB = deriveKeyTree(getRandomBytes(32));
    const wrapped = wrapDek(getRandomBytes(32), treeA.content.publicKey);
    expect(() => unwrapDek(wrapped, treeB.content.secretKey)).not.toThrow();
    expect(unwrapDek(wrapped, treeB.content.secretKey)).toBeNull();
  });

  it('unwrapDek returns null on an unknown version byte', () => {
    const tree = deriveKeyTree(getRandomBytes(32));
    const wrapped = wrapDek(getRandomBytes(32), tree.content.publicKey);
    const badVersion = new Uint8Array(wrapped);
    badVersion[0] = 0x01;
    expect(unwrapDek(badVersion, tree.content.secretKey)).toBeNull();
  });

  it('unwrapDek returns null on empty or truncated input', () => {
    const tree = deriveKeyTree(getRandomBytes(32));
    expect(unwrapDek(new Uint8Array(0), tree.content.secretKey)).toBeNull();
    expect(unwrapDek(new Uint8Array([0x00]), tree.content.secretKey)).toBeNull();
  });

  it('unwrapDek returns null (never throws) on a wrong-length content secret key', () => {
    // Regression: tweetnacl.box.open throws "bad secret key size" for a key
    // that isn't exactly 32 bytes; unwrapDek must catch this to honor its own
    // documented never-throw contract.
    const tree = deriveKeyTree(getRandomBytes(32));
    const wrapped = wrapDek(getRandomBytes(32), tree.content.publicKey);
    expect(() => unwrapDek(wrapped, getRandomBytes(16))).not.toThrow();
    expect(unwrapDek(wrapped, getRandomBytes(16))).toBeNull();
  });
});
