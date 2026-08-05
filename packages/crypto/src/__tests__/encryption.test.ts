import tweetnacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import {
  authChallenge,
  decryptBlob,
  decryptLegacy,
  decryptWithDataKey,
  encryptBlob,
  encryptLegacy,
  encryptWithDataKey,
  getRandomBytes,
  libsodiumDecryptWithSecretKey,
  libsodiumEncryptForPublicKey,
  libsodiumPublicKeyFromSecretKey,
} from "../encryption.js";

describe("encryption.ts (node)", () => {
  describe("encryptWithDataKey / decryptWithDataKey (AES-256-GCM)", () => {
    const dek = getRandomBytes(32);

    it("round-trips objects, arrays, primitives", () => {
      for (const payload of [
        { a: 1, b: "two", c: [1, 2, 3] },
        [1, 2, 3],
        "a string",
        42,
        true,
        null,
      ]) {
        const bundle = encryptWithDataKey(payload, dek);
        expect(decryptWithDataKey(bundle, dek)).toEqual(payload);
      }
    });

    it("bundle layout is [version(1)|nonce(12)|ciphertext|tag(16)]", () => {
      const bundle = encryptWithDataKey({ x: 1 }, dek);
      expect(bundle[0]).toBe(0);
      expect(bundle.length).toBeGreaterThanOrEqual(1 + 12 + 16);
    });

    it("returns null (never throws) on wrong key", () => {
      const bundle = encryptWithDataKey({ secret: true }, dek);
      const wrongKey = getRandomBytes(32);
      expect(() => decryptWithDataKey(bundle, wrongKey)).not.toThrow();
      expect(decryptWithDataKey(bundle, wrongKey)).toBeNull();
    });

    it("returns null on tampered ciphertext", () => {
      const bundle = encryptWithDataKey({ secret: true }, dek);
      const tampered = new Uint8Array(bundle);
      // biome-ignore lint/style/noNonNullAssertion: index is within bounds (bundle is longer than 20 bytes)
      tampered[20]! ^= 0xff;
      expect(decryptWithDataKey(tampered, dek)).toBeNull();
    });

    it("returns null on tampered auth tag", () => {
      const bundle = encryptWithDataKey({ secret: true }, dek);
      const tampered = new Uint8Array(bundle);
      // biome-ignore lint/style/noNonNullAssertion: index is within bounds (non-empty bundle)
      tampered[tampered.length - 1]! ^= 0xff;
      expect(decryptWithDataKey(tampered, dek)).toBeNull();
    });

    it("returns null on truncated / empty / garbage input", () => {
      expect(decryptWithDataKey(new Uint8Array(0), dek)).toBeNull();
      expect(decryptWithDataKey(new Uint8Array(5), dek)).toBeNull();
      expect(decryptWithDataKey(getRandomBytes(50), dek)).toBeNull();
    });

    it("rejects an unknown version byte", () => {
      const bundle = encryptWithDataKey({ x: 1 }, dek);
      const badVersion = new Uint8Array(bundle);
      badVersion[0] = 1;
      expect(decryptWithDataKey(badVersion, dek)).toBeNull();
    });
  });

  describe("encryptLegacy / decryptLegacy (NaCl secretbox)", () => {
    it("round-trips and rejects tamper/wrong key", () => {
      const secret = getRandomBytes(32);
      const bundle = encryptLegacy({ hello: "world" }, secret);
      expect(decryptLegacy(bundle, secret)).toEqual({ hello: "world" });

      const tampered = new Uint8Array(bundle);
      // biome-ignore lint/style/noNonNullAssertion: index is within bounds (non-empty bundle)
      tampered[tampered.length - 1]! ^= 0xff;
      expect(decryptLegacy(tampered, secret)).toBeNull();

      expect(decryptLegacy(bundle, getRandomBytes(32))).toBeNull();
    });

    it("never throws (returns null) on inputs too short to contain a nonce, or a wrong-length key", () => {
      // Regression: tweetnacl.secretbox.open throws "bad nonce size" / "bad key
      // size" instead of returning falsy for malformed input lengths — decryptLegacy
      // must catch this itself to honor the package's never-throw contract.
      expect(() => decryptLegacy(new Uint8Array(0), getRandomBytes(32))).not.toThrow();
      expect(decryptLegacy(new Uint8Array(0), getRandomBytes(32))).toBeNull();
      expect(() => decryptLegacy(new Uint8Array(5), getRandomBytes(32))).not.toThrow();
      expect(decryptLegacy(new Uint8Array(5), getRandomBytes(32))).toBeNull();

      const secret = getRandomBytes(32);
      const bundle = encryptLegacy({ hello: "world" }, secret);
      expect(() => decryptLegacy(bundle, getRandomBytes(16))).not.toThrow();
      expect(decryptLegacy(bundle, getRandomBytes(16))).toBeNull();
    });
  });

  describe("encryptBlob / decryptBlob (NaCl secretbox, raw bytes)", () => {
    it("round-trips binary data and rejects tamper/truncation", () => {
      const key = getRandomBytes(32);
      const data = getRandomBytes(1024);
      const bundle = encryptBlob(data, key);
      expect(decryptBlob(bundle, key)).toEqual(data);

      expect(decryptBlob(new Uint8Array(10), key)).toBeNull();

      const tampered = new Uint8Array(bundle);
      // biome-ignore lint/style/noNonNullAssertion: index is within bounds (bundle is non-empty)
      tampered[0]! ^= 0xff;
      expect(decryptBlob(tampered, key)).toBeNull();
    });

    it("never throws (returns null) on a wrong-length key", () => {
      // Regression: tweetnacl.secretbox.open throws "bad key size" for a key
      // that isn't exactly 32 bytes instead of returning falsy.
      const key = getRandomBytes(32);
      const bundle = encryptBlob(getRandomBytes(16), key);
      expect(() => decryptBlob(bundle, getRandomBytes(16))).not.toThrow();
      expect(decryptBlob(bundle, getRandomBytes(16))).toBeNull();
    });
  });

  describe("libsodiumEncryptForPublicKey / libsodiumDecryptWithSecretKey", () => {
    it("round-trips through a NaCl box keypair", () => {
      const recipient = tweetnacl.box.keyPair();
      const data = new TextEncoder().encode("a secret payload");
      const bundle = libsodiumEncryptForPublicKey(data, recipient.publicKey);
      expect(libsodiumDecryptWithSecretKey(bundle, recipient.secretKey)).toEqual(data);
    });

    it("returns null on wrong recipient key or tamper", () => {
      const recipient = tweetnacl.box.keyPair();
      const other = tweetnacl.box.keyPair();
      const bundle = libsodiumEncryptForPublicKey(
        new TextEncoder().encode("x"),
        recipient.publicKey,
      );
      expect(libsodiumDecryptWithSecretKey(bundle, other.secretKey)).toBeNull();

      const tampered = new Uint8Array(bundle);
      // biome-ignore lint/style/noNonNullAssertion: index is within bounds (non-empty bundle)
      tampered[tampered.length - 1]! ^= 0xff;
      expect(libsodiumDecryptWithSecretKey(tampered, recipient.secretKey)).toBeNull();
    });

    it("never throws (returns null) on a wrong-length recipient secret key", () => {
      // Regression: tweetnacl.box.open throws "bad secret key size" instead of
      // returning falsy — this previously escaped as an uncaught exception all
      // the way up through unwrapDek(), which is documented to never throw.
      const recipient = tweetnacl.box.keyPair();
      const bundle = libsodiumEncryptForPublicKey(
        new TextEncoder().encode("x"),
        recipient.publicKey,
      );
      expect(() => libsodiumDecryptWithSecretKey(bundle, getRandomBytes(16))).not.toThrow();
      expect(libsodiumDecryptWithSecretKey(bundle, getRandomBytes(16))).toBeNull();
    });
  });

  describe("libsodiumPublicKeyFromSecretKey", () => {
    it("matches tweetnacl.box.keyPair.fromSecretKey for the sha512-derived scalar", () => {
      const seed = getRandomBytes(32);
      const hashed = tweetnacl.hash(seed).slice(0, 32);
      const expected = tweetnacl.box.keyPair.fromSecretKey(hashed).publicKey;
      expect(libsodiumPublicKeyFromSecretKey(seed)).toEqual(new Uint8Array(expected));
    });

    it("is deterministic", () => {
      const seed = getRandomBytes(32);
      expect(libsodiumPublicKeyFromSecretKey(seed)).toEqual(libsodiumPublicKeyFromSecretKey(seed));
    });
  });

  describe("authChallenge", () => {
    it("produces a valid Ed25519 signature over the challenge", () => {
      const secret = getRandomBytes(32);
      const { challenge, publicKey, signature } = authChallenge(secret);
      expect(challenge.length).toBe(32);
      expect(tweetnacl.sign.detached.verify(challenge, signature, publicKey)).toBe(true);
    });

    it("produces a fresh random challenge each call", () => {
      const secret = getRandomBytes(32);
      const a = authChallenge(secret);
      const b = authChallenge(secret);
      expect(a.challenge).not.toEqual(b.challenge);
      expect(a.publicKey).toEqual(b.publicKey); // same identity, same seed
    });
  });
});
