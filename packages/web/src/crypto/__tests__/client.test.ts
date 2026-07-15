import { deriveKeyTree, getRandomBytes, wrapDek } from "@falcon/crypto/web";
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
});
