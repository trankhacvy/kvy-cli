import { deriveKeyTree, type EncryptedBox, getRandomBytes, wrapDek } from "@falcon/crypto/web";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryKeyStorage } from "../key-storage.js";
import type { CryptoWorkerRequest, CryptoWorkerRequestPayload } from "../protocol.js";
import { type CryptoWorkerHandler, createCryptoWorkerHandler } from "../worker-handler.js";

function req(id: string, rest: CryptoWorkerRequestPayload): CryptoWorkerRequest {
  return { id, ...rest } as CryptoWorkerRequest;
}

describe("createCryptoWorkerHandler", () => {
  let handler: CryptoWorkerHandler;
  const masterSecret = getRandomBytes(32);
  const tree = deriveKeyTree(masterSecret);
  const dek = getRandomBytes(32);
  const wrappedDek = wrapDek(dek, tree.content.publicKey);

  beforeEach(() => {
    handler = createCryptoWorkerHandler(createMemoryKeyStorage());
  });

  it("seal() fails before any key is initialized", async () => {
    const res = await handler.handle(req("1", { type: "seal", data: { hello: "world" } }));
    expect(res).toEqual({ id: "1", ok: false, error: "no-active-session-key" });
  });

  it("init -> setSessionKey -> seal/open round-trips arbitrary JSON data", async () => {
    const initRes = await handler.handle(req("1", { type: "init", masterSecret }));
    expect(initRes).toEqual({ id: "1", ok: true, result: null });

    const setKeyRes = await handler.handle(req("2", { type: "setSessionKey", wrappedDek }));
    expect(setKeyRes).toEqual({ id: "2", ok: true, result: true });

    const payload = { kind: "text", body: "hello **world**", meta: { n: 1, items: [1, 2, 3] } };
    const sealRes = await handler.handle(req("3", { type: "seal", data: payload }));
    expect(sealRes.ok).toBe(true);
    if (!sealRes.ok) throw new Error("unreachable");
    expect(sealRes.result).toMatchObject({ t: "enc", v: 1, c: expect.any(String) });

    const openRes = await handler.handle(
      req("4", { type: "open", box: sealRes.result as EncryptedBox }),
    );
    expect(openRes).toEqual({ id: "4", ok: true, result: payload });
  });

  it("setSessionKey resolves ok:true, result:false (never throws) for a DEK wrapped to a different key tree", async () => {
    await handler.handle(req("1", { type: "init", masterSecret }));
    const otherTree = deriveKeyTree(getRandomBytes(32));
    const foreignWrappedDek = wrapDek(getRandomBytes(32), otherTree.content.publicKey);

    const res = await handler.handle(
      req("2", { type: "setSessionKey", wrappedDek: foreignWrappedDek }),
    );
    expect(res).toEqual({ id: "2", ok: true, result: false });
  });

  it("setSessionKey fails with not-initialized when no key material exists yet", async () => {
    const res = await handler.handle(req("1", { type: "setSessionKey", wrappedDek }));
    expect(res).toEqual({ id: "1", ok: false, error: "not-initialized" });
  });

  it("open() fails when no active session key is set", async () => {
    await handler.handle(req("1", { type: "init", masterSecret }));
    const res = await handler.handle(req("2", { type: "open", box: { t: "enc", v: 1, c: "abc" } }));
    expect(res).toEqual({ id: "2", ok: false, error: "no-active-session-key" });
  });

  it("open() resolves ok:true, result:null (never throws) for a box sealed under a different DEK", async () => {
    await handler.handle(req("1", { type: "init", masterSecret }));
    await handler.handle(req("2", { type: "setSessionKey", wrappedDek }));
    const sealRes = await handler.handle(req("3", { type: "seal", data: { secret: 42 } }));
    if (!sealRes.ok) throw new Error("unreachable");

    // Rekey to a different DEK, then try to open ciphertext sealed under the old one.
    const otherDek = getRandomBytes(32);
    const otherWrapped = wrapDek(otherDek, tree.content.publicKey);
    await handler.handle(req("4", { type: "setSessionKey", wrappedDek: otherWrapped }));

    const openRes = await handler.handle(
      req("5", { type: "open", box: sealRes.result as EncryptedBox }),
    );
    expect(openRes).toEqual({ id: "5", ok: true, result: null });
  });

  it("clear() wipes in-memory keys and persisted storage — a later call requires init again", async () => {
    const storage = createMemoryKeyStorage();
    handler = createCryptoWorkerHandler(storage);
    await handler.handle(req("1", { type: "init", masterSecret }));
    await handler.handle(req("2", { type: "clear" }));

    expect(await storage.load()).toBeNull();
    const setKeyRes = await handler.handle(req("3", { type: "setSessionKey", wrappedDek }));
    expect(setKeyRes).toEqual({ id: "3", ok: false, error: "not-initialized" });
  });

  it("loads previously-provisioned key material from storage lazily, on first use (worker restart / page reload)", async () => {
    const storage = createMemoryKeyStorage();
    await storage.save(masterSecret);

    // Simulate a fresh worker instance that never received an explicit `init`
    // this session — it should pick up the persisted secret from storage.
    const freshHandler = createCryptoWorkerHandler(storage);
    const res = await freshHandler.handle(req("1", { type: "setSessionKey", wrappedDek }));
    expect(res).toEqual({ id: "1", ok: true, result: true });
  });

  it("re-init drops the previously active session DEK — seal fails until setSessionKey is called again", async () => {
    await handler.handle(req("1", { type: "init", masterSecret }));
    await handler.handle(req("2", { type: "setSessionKey", wrappedDek }));
    const sealed = await handler.handle(req("3", { type: "seal", data: { a: 1 } }));
    expect(sealed.ok).toBe(true);

    // Re-init (e.g. re-authenticating) with a *different* master secret must
    // clear the previously active DEK, not just swap the key tree underneath it.
    const otherSecret = getRandomBytes(32);
    await handler.handle(req("4", { type: "init", masterSecret: otherSecret }));

    const res = await handler.handle(req("5", { type: "seal", data: { a: 2 } }));
    expect(res).toEqual({ id: "5", ok: false, error: "no-active-session-key" });
  });

  it("init persists the new master secret to storage, overwriting whatever was there before", async () => {
    const storage = createMemoryKeyStorage();
    handler = createCryptoWorkerHandler(storage);
    await handler.handle(req("1", { type: "init", masterSecret }));

    const otherSecret = getRandomBytes(32);
    await handler.handle(req("2", { type: "init", masterSecret: otherSecret }));

    expect(await storage.load()).toEqual(otherSecret);
  });
});
