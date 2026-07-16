import {
  decodeBase64,
  decodeRecoveryCode,
  deriveKeyTree,
  encodeBase64,
  getRandomBytes,
  libsodiumDecryptWithSecretKey,
  verifyDetached,
  wrapDek,
} from "@falcon/crypto/web";
import { describe, expect, it } from "vitest";
import { createCryptoBridgeClient } from "../client.js";
import { createMemoryKeyStorage } from "../key-storage.js";
import { createCryptoWorkerHandler } from "../worker-handler.js";
import { containsSecretBytes } from "./bytes-scan.js";
import { createLoopbackWorker } from "./loopback.js";

describe("crypto-bridge client <-> worker RPC", () => {
  it("seal/open round-trips through the postMessage boundary", async () => {
    const masterSecret = getRandomBytes(32);
    const tree = deriveKeyTree(masterSecret);
    const dek = getRandomBytes(32);
    const wrappedDek = wrapDek(dek, tree.content.publicKey);

    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);

    await client.init(masterSecret);
    expect(await client.setSessionKey(wrappedDek)).toBe(true);

    const payload = { kind: "text", body: "hi", nested: [1, 2, { ok: true }] };
    const box = await client.seal(payload);
    expect(box).toMatchObject({ t: "enc", v: 1, c: expect.any(String) });

    const opened = await client.open<typeof payload>(box);
    expect(opened).toEqual(payload);
  });

  it("open() resolves null for a foreign/corrupted box instead of rejecting", async () => {
    const masterSecret = getRandomBytes(32);
    const tree = deriveKeyTree(masterSecret);
    const dek = getRandomBytes(32);
    const wrappedDek = wrapDek(dek, tree.content.publicKey);

    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);
    await client.init(masterSecret);
    await client.setSessionKey(wrappedDek);

    const opened = await client.open({ t: "enc", v: 1, c: "not-real-ciphertext" });
    expect(opened).toBeNull();
  });

  it("rejects the caller's promise when the worker reports an RPC-level error", async () => {
    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);

    // No init() call yet -> "no-active-session-key".
    await expect(client.seal({ a: 1 })).rejects.toThrow("no-active-session-key");
  });

  it("never hands the main thread a message containing the raw master secret, content secret key, or session DEK", async () => {
    const masterSecret = getRandomBytes(32);
    const tree = deriveKeyTree(masterSecret);
    const dek = getRandomBytes(32);
    const wrappedDek = wrapDek(dek, tree.content.publicKey);

    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);

    await client.init(masterSecret);
    await client.setSessionKey(wrappedDek);
    await client.seal({ some: "plaintext", more: [1, 2, 3] });
    await client.open(await client.seal("round-trip-me"));
    await client.clear();

    const secrets = [masterSecret, tree.signing.secretKey, tree.content.secretKey, dek];
    expect(worker.responses.length).toBeGreaterThan(0);
    for (const response of worker.responses) {
      for (const secret of secrets) {
        expect(containsSecretBytes(response, secret)).toBe(false);
      }
    }
  });

  it("getIdentity resolves null, then the provisioned public keys after init", async () => {
    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);

    expect(await client.getIdentity()).toBeNull();

    const masterSecret = getRandomBytes(32);
    const tree = deriveKeyTree(masterSecret);
    await client.init(masterSecret);

    expect(await client.getIdentity()).toEqual({
      signPubKey: expect.any(String),
      contentPubKey: expect.any(String),
    });
    const identity = await client.getIdentity();
    expect(decodeBase64(identity!.signPubKey)).toEqual(tree.signing.publicKey);
    expect(decodeBase64(identity!.contentPubKey)).toEqual(tree.content.publicKey);
  });

  it("signInChallenge produces a challenge/signature that verifies against the provisioned identity", async () => {
    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);

    const masterSecret = getRandomBytes(32);
    const tree = deriveKeyTree(masterSecret);
    await client.init(masterSecret);

    const result = await client.signInChallenge();
    expect(
      verifyDetached(
        decodeBase64(result.challenge),
        decodeBase64(result.signature),
        tree.signing.publicKey,
      ),
    ).toBe(true);
  });

  it("signInChallenge rejects when no identity has been provisioned", async () => {
    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);

    await expect(client.signInChallenge()).rejects.toThrow("not-initialized");
  });

  it("exportRecoveryCode round-trips to the provisioned master secret", async () => {
    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);

    const masterSecret = getRandomBytes(32);
    await client.init(masterSecret);

    const code = await client.exportRecoveryCode();
    expect(decodeRecoveryCode(code)).toEqual(masterSecret);
  });

  it("sealForPeer seals the master secret so only the peer's matching secret key can open it", async () => {
    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);

    const masterSecret = getRandomBytes(32);
    await client.init(masterSecret);

    const peer = deriveKeyTree(getRandomBytes(32)).content;
    const sealed = await client.sealForPeer(encodeBase64(peer.publicKey));

    const opened = libsodiumDecryptWithSecretKey(decodeBase64(sealed), peer.secretKey);
    expect(opened).not.toBeNull();
    expect(opened?.slice(1)).toEqual(masterSecret);
  });
});
