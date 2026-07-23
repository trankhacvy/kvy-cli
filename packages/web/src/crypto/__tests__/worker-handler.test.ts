import {
  decodeBase64,
  deriveKeyTree,
  type EncryptedBox,
  encodeBase64,
  getRandomBytes,
  libsodiumDecryptWithSecretKey,
  ready,
  wrapDek,
} from "@falcon/crypto/web";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryKeyStorage } from "../key-storage.js";
import type { CryptoWorkerRequest, CryptoWorkerRequestPayload } from "../protocol.js";
import { type CryptoWorkerHandler, createCryptoWorkerHandler } from "../worker-handler.js";

function req(id: string, rest: CryptoWorkerRequestPayload): CryptoWorkerRequest {
  return { id, ...rest } as CryptoWorkerRequest;
}

const PIN = "123456";
const OTHER_PIN = "000000";

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
    const initRes = await handler.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));
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
    await handler.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));
    const otherTree = deriveKeyTree(getRandomBytes(32));
    const foreignWrappedDek = wrapDek(getRandomBytes(32), otherTree.content.publicKey);

    const res = await handler.handle(
      req("2", { type: "setSessionKey", wrappedDek: foreignWrappedDek }),
    );
    expect(res).toEqual({ id: "2", ok: true, result: false });
  });

  it("setSessionKey fails with not-initialized when nothing has ever been provisioned", async () => {
    const res = await handler.handle(req("1", { type: "setSessionKey", wrappedDek }));
    expect(res).toEqual({ id: "1", ok: false, error: "not-initialized" });
  });

  it("setSessionKey fails with locked on a fresh worker over an already-provisioned (but not yet unlocked) device", async () => {
    const storage = createMemoryKeyStorage();
    const provisioning = createCryptoWorkerHandler(storage);
    await provisioning.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));

    const freshHandler = createCryptoWorkerHandler(storage);
    const res = await freshHandler.handle(req("1", { type: "setSessionKey", wrappedDek }));
    expect(res).toEqual({ id: "1", ok: false, error: "locked" });
  });

  it("open() fails when no active session key is set", async () => {
    await handler.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));
    const res = await handler.handle(req("2", { type: "open", box: { t: "enc", v: 1, c: "abc" } }));
    expect(res).toEqual({ id: "2", ok: false, error: "no-active-session-key" });
  });

  it("open() resolves ok:true, result:null (never throws) for a box sealed under a different DEK", async () => {
    await handler.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));
    await handler.handle(req("2", { type: "setSessionKey", wrappedDek }));
    const sealRes = await handler.handle(req("3", { type: "seal", data: { secret: 42 } }));
    if (!sealRes.ok) throw new Error("unreachable");

    const otherDek = getRandomBytes(32);
    const otherWrapped = wrapDek(otherDek, tree.content.publicKey);
    await handler.handle(req("4", { type: "setSessionKey", wrappedDek: otherWrapped }));

    const openRes = await handler.handle(
      req("5", { type: "open", box: sealRes.result as EncryptedBox }),
    );
    expect(openRes).toEqual({ id: "5", ok: true, result: null });
  });

  it("sealBlob() fails before any session key is set", async () => {
    const res = await handler.handle(
      req("1", { type: "sealBlob", data: new Uint8Array([1, 2, 3]) }),
    );
    expect(res).toEqual({ id: "1", ok: false, error: "no-active-session-key" });
  });

  it("init -> setSessionKey -> sealBlob/openBlob round-trips binary data", async () => {
    await handler.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));
    await handler.handle(req("2", { type: "setSessionKey", wrappedDek }));

    const plaintext = new Uint8Array([10, 20, 30, 40, 250]);
    const sealRes = await handler.handle(req("3", { type: "sealBlob", data: plaintext }));
    expect(sealRes.ok).toBe(true);
    if (!sealRes.ok) throw new Error("unreachable");
    expect(sealRes.result).toBeInstanceOf(Uint8Array);
    expect((sealRes.result as Uint8Array).length).toBeGreaterThan(plaintext.length);

    const openRes = await handler.handle(
      req("4", { type: "openBlob", bundle: sealRes.result as Uint8Array }),
    );
    expect(openRes.ok).toBe(true);
    if (!openRes.ok) throw new Error("unreachable");
    expect(openRes.result).toEqual(plaintext);
  });

  it("clear() wipes in-memory keys and persisted storage — a later call requires init again", async () => {
    const storage = createMemoryKeyStorage();
    handler = createCryptoWorkerHandler(storage);
    await handler.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));
    await handler.handle(req("2", { type: "clear" }));

    expect(await storage.load()).toBeNull();
    const setKeyRes = await handler.handle(req("3", { type: "setSessionKey", wrappedDek }));
    expect(setKeyRes).toEqual({ id: "3", ok: false, error: "not-initialized" });
  });

  it("a fresh worker instance requires unlock — it never auto-loads provisioned key material", async () => {
    const storage = createMemoryKeyStorage();
    const provisioning = createCryptoWorkerHandler(storage);
    await provisioning.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));

    const freshHandler = createCryptoWorkerHandler(storage);
    const res = await freshHandler.handle(req("1", { type: "setSessionKey", wrappedDek }));
    expect(res).toEqual({ id: "1", ok: false, error: "locked" });

    const unlockRes = await freshHandler.handle(req("2", { type: "unlock", pin: PIN }));
    expect(unlockRes).toEqual({ id: "2", ok: true, result: true });

    const afterUnlock = await freshHandler.handle(req("3", { type: "setSessionKey", wrappedDek }));
    expect(afterUnlock).toEqual({ id: "3", ok: true, result: true });
  });

  it("unlock resolves false (never throws) for a wrong PIN", async () => {
    const storage = createMemoryKeyStorage();
    const provisioning = createCryptoWorkerHandler(storage);
    await provisioning.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));

    const freshHandler = createCryptoWorkerHandler(storage);
    const res = await freshHandler.handle(req("1", { type: "unlock", pin: OTHER_PIN }));
    expect(res).toEqual({ id: "1", ok: true, result: false });
  });

  it("unlock fails with not-initialized when nothing has ever been provisioned", async () => {
    const res = await handler.handle(req("1", { type: "unlock", pin: PIN }));
    expect(res).toEqual({ id: "1", ok: false, error: "not-initialized" });
  });

  it("re-init drops the previously active session DEK — seal fails until setSessionKey is called again", async () => {
    await handler.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));
    await handler.handle(req("2", { type: "setSessionKey", wrappedDek }));
    const sealed = await handler.handle(req("3", { type: "seal", data: { a: 1 } }));
    expect(sealed.ok).toBe(true);

    const otherSecret = getRandomBytes(32);
    await handler.handle(req("4", { type: "init", masterSecret: otherSecret, pin: PIN, refreshToken: "other-refresh-token" }));

    const res = await handler.handle(req("5", { type: "seal", data: { a: 2 } }));
    expect(res).toEqual({ id: "5", ok: false, error: "no-active-session-key" });
  });

  it("init persists the new master secret (PIN-wrapped) to storage, overwriting whatever was there before", async () => {
    const storage = createMemoryKeyStorage();
    handler = createCryptoWorkerHandler(storage);
    await handler.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));

    const otherSecret = getRandomBytes(32);
    await handler.handle(req("2", { type: "init", masterSecret: otherSecret, pin: PIN, refreshToken: "other-refresh-token" }));

    const stored = await storage.load();
    expect(stored).not.toBeNull();
    // Storage never holds the raw secret — only the wrapped blob + public keys.
    expect(stored?.wrapped.ct).not.toContain(encodeBase64(masterSecret));
    expect(stored?.signPubKey).toBe(encodeBase64(deriveKeyTree(otherSecret).signing.publicKey));
  });

  it("getIdentity resolves null before any identity is provisioned", async () => {
    const res = await handler.handle(req("1", { type: "getIdentity" }));
    expect(res).toEqual({ id: "1", ok: true, result: null });
  });

  it("getIdentity resolves the public keys after init, matching the derived key tree", async () => {
    await handler.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));
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

  it("getIdentity answers from the stored record's plaintext public keys — no unlock required", async () => {
    const storage = createMemoryKeyStorage();
    const provisioning = createCryptoWorkerHandler(storage);
    await provisioning.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));

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

  it("sealForPeer fails with not-initialized when no identity exists yet", async () => {
    const ephPub = getRandomBytes(32);
    const res = await handler.handle(
      req("1", { type: "sealForPeer", ephPub: encodeBase64(ephPub), refreshToken: "rt" }),
    );
    expect(res).toEqual({ id: "1", ok: false, error: "not-initialized" });
  });

  it("sealForPeer fails with locked on a fresh, not-yet-unlocked worker", async () => {
    const storage = createMemoryKeyStorage();
    const provisioning = createCryptoWorkerHandler(storage);
    await provisioning.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));

    const freshHandler = createCryptoWorkerHandler(storage);
    const res = await freshHandler.handle(
      req("1", {
        type: "sealForPeer",
        ephPub: encodeBase64(getRandomBytes(32)),
        refreshToken: "rt",
      }),
    );
    expect(res).toEqual({ id: "1", ok: false, error: "locked" });
  });

  it("sealForPeer rejects a malformed (wrong-length) ephemeral public key", async () => {
    await handler.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));
    const res = await handler.handle(
      req("2", {
        type: "sealForPeer",
        ephPub: encodeBase64(new Uint8Array([1, 2, 3])),
        refreshToken: "rt",
      }),
    );
    expect(res).toEqual({ id: "2", ok: false, error: "invalid-eph-pub" });
  });

  it("sealForPeer produces a box that only the peer's matching secret key can open, revealing the master secret + refresh token", async () => {
    await ready;
    await handler.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));

    const peerKeyPair = tweetnaclBoxKeyPair();
    const res = await handler.handle(
      req("2", {
        type: "sealForPeer",
        ephPub: encodeBase64(peerKeyPair.publicKey),
        refreshToken: "the-refresh-token",
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const opened = libsodiumDecryptWithSecretKey(
      decodeBase64(res.result as string),
      peerKeyPair.secretKey,
    );
    expect(opened).not.toBeNull();
    expect(opened?.[0]).toBe(0x01);
    expect(opened?.slice(1, 1 + masterSecret.length)).toEqual(masterSecret);
    expect(new TextDecoder().decode(opened?.slice(1 + masterSecret.length))).toBe(
      "the-refresh-token",
    );
  });

  it("sealForPeer is not openable by an unrelated secret key", async () => {
    await ready;
    await handler.handle(req("1", { type: "init", masterSecret, pin: PIN, refreshToken: "test-refresh-token" }));

    const peerKeyPair = tweetnaclBoxKeyPair();
    const wrongKeyPair = tweetnaclBoxKeyPair();
    const res = await handler.handle(
      req("2", {
        type: "sealForPeer",
        ephPub: encodeBase64(peerKeyPair.publicKey),
        refreshToken: "rt",
      }),
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
