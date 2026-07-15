import {
  decodeBase64,
  decodeRecoveryCode,
  deriveKeyTree,
  encodeBase64,
  type EncryptedBox,
  getRandomBytes,
  libsodiumDecryptWithSecretKey,
  ready,
  verifyDetached,
  wrapDek,
} from "@falcon/crypto/web";
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

  it("getIdentity resolves null before any identity is provisioned", async () => {
    const res = await handler.handle(req("1", { type: "getIdentity" }));
    expect(res).toEqual({ id: "1", ok: true, result: null });
  });

  it("getIdentity resolves the public keys after init, matching the derived key tree", async () => {
    await handler.handle(req("1", { type: "init", masterSecret }));
    const res = await handler.handle(req("2", { type: "getIdentity" }));
    expect(res).toEqual({
      id: "2",
      ok: true,
      result: {
        signPubKey: encodeBase64(tree.signing.publicKey),
        contentPubKey: encodeBase64(tree.content.publicKey),
      },
    });
  });

  it("getIdentity loads a previously-provisioned identity from storage lazily", async () => {
    const storage = createMemoryKeyStorage();
    await storage.save(masterSecret);
    const freshHandler = createCryptoWorkerHandler(storage);

    const res = await freshHandler.handle(req("1", { type: "getIdentity" }));
    expect(res).toEqual({
      id: "1",
      ok: true,
      result: {
        signPubKey: encodeBase64(tree.signing.publicKey),
        contentPubKey: encodeBase64(tree.content.publicKey),
      },
    });
  });

  it("signInChallenge fails with not-initialized when no identity exists yet", async () => {
    const res = await handler.handle(req("1", { type: "signInChallenge" }));
    expect(res).toEqual({ id: "1", ok: false, error: "not-initialized" });
  });

  it("signInChallenge mints a fresh challenge signed by the provisioned identity", async () => {
    await handler.handle(req("1", { type: "init", masterSecret }));
    const res = await handler.handle(req("2", { type: "signInChallenge" }));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const result = res.result as {
      signPubKey: string;
      contentPubKey: string;
      challenge: string;
      signature: string;
    };
    expect(result.signPubKey).toBe(encodeBase64(tree.signing.publicKey));
    expect(result.contentPubKey).toBe(encodeBase64(tree.content.publicKey));
    expect(
      verifyDetached(
        decodeBase64(result.challenge),
        decodeBase64(result.signature),
        tree.signing.publicKey,
      ),
    ).toBe(true);
  });

  it("signInChallenge mints a different challenge on each call", async () => {
    await handler.handle(req("1", { type: "init", masterSecret }));
    const a = await handler.handle(req("2", { type: "signInChallenge" }));
    const b = await handler.handle(req("3", { type: "signInChallenge" }));
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect((a.result as { challenge: string }).challenge).not.toBe(
      (b.result as { challenge: string }).challenge,
    );
  });

  it("exportRecoveryCode fails with not-initialized when no identity exists yet", async () => {
    const res = await handler.handle(req("1", { type: "exportRecoveryCode" }));
    expect(res).toEqual({ id: "1", ok: false, error: "not-initialized" });
  });

  it("exportRecoveryCode round-trips back to the exact provisioned master secret", async () => {
    await handler.handle(req("1", { type: "init", masterSecret }));
    const res = await handler.handle(req("2", { type: "exportRecoveryCode" }));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(decodeRecoveryCode(res.result as string)).toEqual(masterSecret);
  });

  it("sealForPeer fails with not-initialized when no identity exists yet", async () => {
    const ephPub = getRandomBytes(32);
    const res = await handler.handle(
      req("1", { type: "sealForPeer", ephPub: encodeBase64(ephPub) }),
    );
    expect(res).toEqual({ id: "1", ok: false, error: "not-initialized" });
  });

  it("sealForPeer rejects a malformed (wrong-length) ephemeral public key", async () => {
    await handler.handle(req("1", { type: "init", masterSecret }));
    const res = await handler.handle(
      req("2", { type: "sealForPeer", ephPub: encodeBase64(new Uint8Array([1, 2, 3])) }),
    );
    expect(res).toEqual({ id: "2", ok: false, error: "invalid-eph-pub" });
  });

  it("sealForPeer produces a box that only the peer's matching secret key can open, revealing the master secret", async () => {
    await ready;
    await handler.handle(req("1", { type: "init", masterSecret }));

    const peerKeyPair = tweetnaclBoxKeyPair();
    const res = await handler.handle(
      req("2", { type: "sealForPeer", ephPub: encodeBase64(peerKeyPair.publicKey) }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const opened = libsodiumDecryptWithSecretKey(
      decodeBase64(res.result as string),
      peerKeyPair.secretKey,
    );
    expect(opened).not.toBeNull();
    expect(opened?.[0]).toBe(0);
    expect(opened?.slice(1)).toEqual(masterSecret);
  });

  it("sealForPeer is not openable by an unrelated secret key", async () => {
    await ready;
    await handler.handle(req("1", { type: "init", masterSecret }));

    const peerKeyPair = tweetnaclBoxKeyPair();
    const wrongKeyPair = tweetnaclBoxKeyPair();
    const res = await handler.handle(
      req("2", { type: "sealForPeer", ephPub: encodeBase64(peerKeyPair.publicKey) }),
    );
    if (!res.ok) throw new Error("unreachable");

    const opened = libsodiumDecryptWithSecretKey(
      decodeBase64(res.result as string),
      wrongKeyPair.secretKey,
    );
    expect(opened).toBeNull();
  });
});

/**
 * A fresh X25519 keypair for the "peer" side of sealForPeer tests — reuses
 * `deriveKeyTree`'s own content-keypair derivation (already proven mutually
 * consistent with libsodium's sealed-box functions by dek.test.ts) rather
 * than hand-rolling key generation here.
 */
function tweetnaclBoxKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return deriveKeyTree(getRandomBytes(32)).content;
}
