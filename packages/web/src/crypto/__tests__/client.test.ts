import {
  decodeBase64,
  deriveKeyTree,
  encodeBase64,
  getRandomBytes,
  libsodiumDecryptWithSecretKey,
  wrapDek,
} from "@falcon/crypto/web";
import { describe, expect, it } from "vitest";
import { createCryptoBridgeClient } from "../client.js";
import { createMemoryKeyStorage } from "../key-storage.js";
import { createCryptoWorkerHandler } from "../worker-handler.js";
import { containsSecretBytes } from "./bytes-scan.js";
import { createLoopbackWorker } from "./loopback.js";

const PIN = "123456";

describe("crypto-bridge client <-> worker RPC", () => {
  it("seal/open round-trips through the postMessage boundary", async () => {
    const masterSecret = getRandomBytes(32);
    const tree = deriveKeyTree(masterSecret);
    const dek = getRandomBytes(32);
    const wrappedDek = wrapDek(dek, tree.content.publicKey);

    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);

    await client.init(masterSecret, PIN, "test-refresh-token");
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
    await client.init(masterSecret, PIN, "test-refresh-token");
    await client.setSessionKey(wrappedDek);

    const opened = await client.open({ t: "enc", v: 1, c: "not-real-ciphertext" });
    expect(opened).toBeNull();
  });

  it("sealBlob/openBlob round-trips binary attachment data through the postMessage boundary", async () => {
    const masterSecret = getRandomBytes(32);
    const tree = deriveKeyTree(masterSecret);
    const dek = getRandomBytes(32);
    const wrappedDek = wrapDek(dek, tree.content.publicKey);

    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);

    await client.init(masterSecret, PIN, "test-refresh-token");
    expect(await client.setSessionKey(wrappedDek)).toBe(true);

    const attachment = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
    const bundle = await client.sealBlob(attachment);
    expect(bundle).toBeInstanceOf(Uint8Array);
    expect(bundle.length).toBeGreaterThan(attachment.length);

    const opened = await client.openBlob(bundle);
    expect(opened).toEqual(attachment);
  });

  it("openBlob() resolves null for a corrupted bundle instead of rejecting", async () => {
    const masterSecret = getRandomBytes(32);
    const tree = deriveKeyTree(masterSecret);
    const dek = getRandomBytes(32);
    const wrappedDek = wrapDek(dek, tree.content.publicKey);

    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);
    await client.init(masterSecret, PIN, "test-refresh-token");
    await client.setSessionKey(wrappedDek);

    const opened = await client.openBlob(new Uint8Array([1, 2, 3]));
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

    await client.init(masterSecret, PIN, "test-refresh-token");
    await client.setSessionKey(wrappedDek);
    await client.seal({ some: "plaintext", more: [1, 2, 3] });
    await client.open(await client.seal("round-trip-me"));
    await client.openBlob(await client.sealBlob(new Uint8Array([9, 9, 9])));
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
    await client.init(masterSecret, PIN, "test-refresh-token");

    expect(await client.getIdentity()).toEqual({
      signPubKey: expect.any(String),
      contentPubKey: expect.any(String),
    });
    const identity = await client.getIdentity();
    expect(decodeBase64(identity!.signPubKey)).toEqual(tree.signing.publicKey);
    expect(decodeBase64(identity!.contentPubKey)).toEqual(tree.content.publicKey);
  });

  it("a fresh worker (e.g. after a page reload) requires unlock — getIdentity still answers, but key ops don't", async () => {
    const storage = createMemoryKeyStorage();
    const provisioningWorker = createLoopbackWorker(createCryptoWorkerHandler(storage));
    const provisioningClient = createCryptoBridgeClient(provisioningWorker);
    const masterSecret = getRandomBytes(32);
    await provisioningClient.init(masterSecret, PIN, "test-refresh-token");

    const freshWorker = createLoopbackWorker(createCryptoWorkerHandler(storage));
    const freshClient = createCryptoBridgeClient(freshWorker);

    // No unlock required for this.
    expect(await freshClient.getIdentity()).not.toBeNull();

    // But an unwrap-requiring op fails until unlock() succeeds.
    await expect(
      freshClient.bindKeysProof("acct", encodeBase64(getRandomBytes(32))),
    ).rejects.toThrow("locked");

    expect(await freshClient.unlock("wrong-pin")).toBe(false);
    expect(await freshClient.unlock(PIN)).toBe(true);

    const proof = await freshClient.bindKeysProof("acct", encodeBase64(getRandomBytes(32)));
    expect(proof.signPubKey).toEqual(await freshClient.getIdentity().then((i) => i?.signPubKey));
  });

  it("unlock rejects with not-initialized when nothing has ever been provisioned on this device", async () => {
    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);

    await expect(client.unlock(PIN)).rejects.toThrow("not-initialized");
  });

  it("sealForPeer seals the master secret + refresh token so only the peer's matching secret key can open it", async () => {
    const worker = createLoopbackWorker(createCryptoWorkerHandler(createMemoryKeyStorage()));
    const client = createCryptoBridgeClient(worker);

    const masterSecret = getRandomBytes(32);
    await client.init(masterSecret, PIN, "test-refresh-token");

    const peer = deriveKeyTree(getRandomBytes(32)).content;
    const sealed = await client.sealForPeer(encodeBase64(peer.publicKey), "the-refresh-token");

    const opened = libsodiumDecryptWithSecretKey(decodeBase64(sealed), peer.secretKey);
    expect(opened).not.toBeNull();
    expect(opened?.slice(1, 1 + masterSecret.length)).toEqual(masterSecret);
    expect(new TextDecoder().decode(opened?.slice(1 + masterSecret.length))).toBe(
      "the-refresh-token",
    );
  });
});
