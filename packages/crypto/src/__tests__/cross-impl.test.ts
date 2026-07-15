/**
 * Cross-implementation test vectors: the node build (tweetnacl + node:crypto)
 * and the browser build (libsodium-wrappers + WebCrypto) must produce and
 * consume byte-identical wire formats. Runs under vitest's Node environment —
 * libsodium-wrappers is WASM (platform-agnostic) and Node 20+ exposes the
 * WebCrypto `crypto.subtle` global natively, so both builds run for real here,
 * not mocked.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { open as openNode, seal as sealNode } from "../box.js";
import { open as openWeb, seal as sealWeb } from "../box.web.js";
import { unwrapDek as unwrapDekNode, wrapDek as wrapDekNode } from "../dek.js";
import { unwrapDek as unwrapDekWeb, wrapDek as wrapDekWeb } from "../dek.web.js";
import * as node from "../encryption.js";
import * as web from "../encryption.web.js";
import { deriveKeyTree } from "../keys.js";

beforeAll(async () => {
  await web.ready;
});

describe("cross-impl: encryptWithDataKey / decryptWithDataKey (AES-256-GCM)", () => {
  it("node encrypts -> web decrypts", async () => {
    const dek = node.getRandomBytes(32);
    const payload = { t: "text", md: "hello from node" };
    const bundle = node.encryptWithDataKey(payload, dek);
    await expect(web.decryptWithDataKey(bundle, dek)).resolves.toEqual(payload);
  });

  it("web encrypts -> node decrypts", async () => {
    const dek = node.getRandomBytes(32);
    const payload = { t: "text", md: "hello from web" };
    const bundle = await web.encryptWithDataKey(payload, dek);
    expect(node.decryptWithDataKey(bundle, dek)).toEqual(payload);
  });

  it("a corrupted bundle is rejected on the other platform too", async () => {
    const dek = node.getRandomBytes(32);

    const webBundle = await web.encryptWithDataKey({ x: 1 }, dek);
    const webTampered = new Uint8Array(webBundle);
    webTampered[webTampered.length - 1]! ^= 0xff;
    expect(node.decryptWithDataKey(webTampered, dek)).toBeNull();

    const nodeBundle = node.encryptWithDataKey({ y: 2 }, dek);
    const nodeTampered = new Uint8Array(nodeBundle);
    nodeTampered[nodeTampered.length - 1]! ^= 0xff;
    await expect(web.decryptWithDataKey(nodeTampered, dek)).resolves.toBeNull();
  });
});

describe("cross-impl: NaCl box (libsodiumEncryptForPublicKey / libsodiumDecryptWithSecretKey)", () => {
  it("same seed derives the same public key on both platforms", () => {
    const seed = node.getRandomBytes(32);
    expect(node.libsodiumPublicKeyFromSecretKey(seed)).toEqual(
      web.libsodiumPublicKeyFromSecretKey(seed),
    );
  });

  it("node encrypts -> web decrypts, and vice versa", () => {
    const recipient = deriveKeyTree(node.getRandomBytes(32)).content;

    const fromNode = node.libsodiumEncryptForPublicKey(
      new TextEncoder().encode("from node"),
      recipient.publicKey,
    );
    expect(web.libsodiumDecryptWithSecretKey(fromNode, recipient.secretKey)).toEqual(
      new TextEncoder().encode("from node"),
    );

    const fromWeb = web.libsodiumEncryptForPublicKey(
      new TextEncoder().encode("from web"),
      recipient.publicKey,
    );
    expect(node.libsodiumDecryptWithSecretKey(fromWeb, recipient.secretKey)).toEqual(
      new TextEncoder().encode("from web"),
    );
  });
});

describe("cross-impl: NaCl secretbox (encryptLegacy / encryptBlob)", () => {
  it("encryptLegacy: node encrypts -> web decrypts, and vice versa", () => {
    const secret = node.getRandomBytes(32);
    const fromNode = node.encryptLegacy({ a: 1 }, secret);
    expect(web.decryptLegacy(fromNode, secret)).toEqual({ a: 1 });

    const fromWeb = web.encryptLegacy({ b: 2 }, secret);
    expect(node.decryptLegacy(fromWeb, secret)).toEqual({ b: 2 });
  });

  it("encryptBlob: node encrypts -> web decrypts, and vice versa", () => {
    const key = node.getRandomBytes(32);
    const data = node.getRandomBytes(256);
    const fromNode = node.encryptBlob(data, key);
    expect(web.decryptBlob(fromNode, key)).toEqual(data);

    const fromWeb = web.encryptBlob(data, key);
    expect(node.decryptBlob(fromWeb, key)).toEqual(data);
  });
});

describe("cross-impl: EncryptedBox seal/open", () => {
  it("node seals -> web opens", async () => {
    const dek = node.getRandomBytes(32);
    const payload = { t: "tool-start", name: "bash" };
    const box = sealNode(payload, dek);
    await expect(openWeb(box, dek)).resolves.toEqual(payload);
  });

  it("web seals -> node opens", async () => {
    const dek = node.getRandomBytes(32);
    const payload = { t: "tool-end", ok: true };
    const box = await sealWeb(payload, dek);
    expect(openNode(box, dek)).toEqual(payload);
  });
});

describe("cross-impl: wrapDek / unwrapDek", () => {
  it("node wraps -> web unwraps, and vice versa", () => {
    const recipient = deriveKeyTree(node.getRandomBytes(32)).content;
    const dek = node.getRandomBytes(32);

    const wrappedByNode = wrapDekNode(dek, recipient.publicKey);
    expect(unwrapDekWeb(wrappedByNode, recipient.secretKey)).toEqual(dek);

    const wrappedByWeb = wrapDekWeb(dek, recipient.publicKey);
    expect(unwrapDekNode(wrappedByWeb, recipient.secretKey)).toEqual(dek);
  });
});
