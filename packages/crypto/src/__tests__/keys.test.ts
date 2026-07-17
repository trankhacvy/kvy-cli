import tweetnacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { decryptBlob, encryptBlob, getRandomBytes } from "../encryption.js";
import { deriveBlobKey, deriveKeyTree, signDetached } from "../keys.js";

describe("deriveKeyTree", () => {
  it("is deterministic for a given masterSecret", () => {
    const masterSecret = getRandomBytes(32);
    const a = deriveKeyTree(masterSecret);
    const b = deriveKeyTree(masterSecret);
    expect(a.signing.publicKey).toEqual(b.signing.publicKey);
    expect(a.content.publicKey).toEqual(b.content.publicKey);
    expect(a.anonId).toBe(b.anonId);
    expect(a.blobMasterKey).toEqual(b.blobMasterKey);
  });

  it("produces cryptographically independent keys per domain (no accidental reuse)", () => {
    const tree = deriveKeyTree(getRandomBytes(32));
    const values = [
      Buffer.from(tree.signing.secretKey).toString("hex"),
      Buffer.from(tree.content.secretKey).toString("hex"),
      Buffer.from(new TextEncoder().encode(tree.anonId)).toString("hex"),
      Buffer.from(tree.blobMasterKey).toString("hex"),
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it("different masterSecrets produce different trees", () => {
    const a = deriveKeyTree(getRandomBytes(32));
    const b = deriveKeyTree(getRandomBytes(32));
    expect(a.signing.publicKey).not.toEqual(b.signing.publicKey);
    expect(a.content.publicKey).not.toEqual(b.content.publicKey);
    expect(a.anonId).not.toBe(b.anonId);
  });

  it("signing keypair is a valid Ed25519 keypair usable for authChallenge-style signing", () => {
    const tree = deriveKeyTree(getRandomBytes(32));
    const message = new TextEncoder().encode("challenge");
    const signature = tweetnacl.sign.detached(message, tree.signing.secretKey);
    expect(tweetnacl.sign.detached.verify(message, signature, tree.signing.publicKey)).toBe(true);
  });

  it("content keypair is a valid X25519 box keypair", () => {
    const tree = deriveKeyTree(getRandomBytes(32));
    const other = tweetnacl.box.keyPair();
    const nonce = getRandomBytes(tweetnacl.box.nonceLength);
    const message = new TextEncoder().encode("hi");
    const ct = tweetnacl.box(message, nonce, tree.content.publicKey, other.secretKey);
    const opened = tweetnacl.box.open(ct, nonce, other.publicKey, tree.content.secretKey);
    expect(opened).toEqual(message);
  });

  it("anonId is 16 lowercase hex chars", () => {
    const tree = deriveKeyTree(getRandomBytes(32));
    expect(tree.anonId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("blobMasterKey is 32 bytes (usable as a secretbox key)", () => {
    const tree = deriveKeyTree(getRandomBytes(32));
    expect(tree.blobMasterKey.length).toBe(32);
  });
});

describe("deriveBlobKey", () => {
  it("is deterministic for a given DEK", () => {
    const dek = getRandomBytes(32);
    expect(deriveBlobKey(dek)).toEqual(deriveBlobKey(dek));
  });

  it("is 32 bytes, usable as an encryptBlob/decryptBlob secretbox key", () => {
    const dek = getRandomBytes(32);
    const blobKey = deriveBlobKey(dek);
    expect(blobKey.length).toBe(32);

    const plaintext = new TextEncoder().encode("attachment bytes");
    const bundle = encryptBlob(plaintext, blobKey);
    expect(decryptBlob(bundle, blobKey)).toEqual(plaintext);
  });

  it("different DEKs produce different blob keys", () => {
    const a = deriveBlobKey(getRandomBytes(32));
    const b = deriveBlobKey(getRandomBytes(32));
    expect(a).not.toEqual(b);
  });

  it("is independent from deriveKeyTree's domains for the same input bytes", () => {
    const secret = getRandomBytes(32);
    const blobKey = deriveBlobKey(secret);
    const tree = deriveKeyTree(secret);
    expect(Buffer.from(blobKey).toString("hex")).not.toBe(
      Buffer.from(tree.blobMasterKey).toString("hex"),
    );
  });
});

describe("signDetached", () => {
  it("produces a signature verifiable with the matching public key", () => {
    const tree = deriveKeyTree(getRandomBytes(32));
    const challenge = getRandomBytes(32);
    const signature = signDetached(challenge, tree.signing.secretKey);
    expect(tweetnacl.sign.detached.verify(challenge, signature, tree.signing.publicKey)).toBe(true);
  });

  it("a signature does not verify against a different key tree's public key", () => {
    const treeA = deriveKeyTree(getRandomBytes(32));
    const treeB = deriveKeyTree(getRandomBytes(32));
    const challenge = getRandomBytes(32);
    const signature = signDetached(challenge, treeA.signing.secretKey);
    expect(tweetnacl.sign.detached.verify(challenge, signature, treeB.signing.publicKey)).toBe(
      false,
    );
  });
});
