import {
  decodeBase64,
  deriveKeyTree,
  type EncryptedBox,
  encodeBase64,
  generateEphemeralKeyPair,
  getRandomBytes,
  libsodiumDecryptWithSecretKey,
  libsodiumEncryptForPublicKey,
  ready,
  wrapDek,
  wrapWithPin,
} from "@falcon/crypto/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AnyStoredKeyRecord,
  createMemoryKeyStorage,
  type KeyStorage,
} from "../key-storage.js";
import type { CryptoWorkerRequest, CryptoWorkerRequestPayload } from "../protocol.js";
import { createMemorySessionStorage, type SessionStorage } from "../session-storage.js";
import { type CryptoWorkerHandler, createCryptoWorkerHandler } from "../worker-handler.js";

function req(id: string, rest: CryptoWorkerRequestPayload): CryptoWorkerRequest {
  return { id, ...rest } as CryptoWorkerRequest;
}

const KEY_SHARE_PAYLOAD_VERSION = 0x02;
const TEST_ACCOUNT_ID = "acct-test";

describe("createCryptoWorkerHandler", () => {
  let handler: CryptoWorkerHandler;
  let storage: KeyStorage;
  let sessions: SessionStorage;
  const masterSecret = getRandomBytes(32);
  const tree = deriveKeyTree(masterSecret);
  const dek = getRandomBytes(32);
  const wrappedDek = wrapDek(dek, tree.content.publicKey);

  function init(id: string, accountId: string = TEST_ACCOUNT_ID) {
    return handler.handle(
      req(id, {
        type: "init",
        masterSecret,
        refreshToken: "test-refresh-token",
        accountId,
        mode: "device",
      }),
    );
  }

  beforeEach(() => {
    storage = createMemoryKeyStorage();
    sessions = createMemorySessionStorage();
    handler = createCryptoWorkerHandler(storage, sessions);
  });

  it("seal() fails before any key is initialized", async () => {
    const res = await handler.handle(req("1", { type: "seal", data: { hello: "world" } }));
    expect(res).toEqual({ id: "1", ok: false, error: "no-active-session-key" });
  });

  it("init -> setSessionKey -> seal/open round-trips arbitrary JSON data", async () => {
    expect(await init("1")).toEqual({ id: "1", ok: true, result: null });

    const setKeyRes = await handler.handle(req("2", { type: "setSessionKey", wrappedDek }));
    expect(setKeyRes).toEqual({ id: "2", ok: true, result: true });

    const payload = { kind: "text", body: "hello **world**", meta: { n: 1, items: [1, 2, 3] } };
    const sealRes = await handler.handle(req("3", { type: "seal", data: payload }));
    expect(sealRes.ok).toBe(true);
    if (!sealRes.ok) throw new Error("unreachable");

    const openRes = await handler.handle(
      req("4", { type: "open", box: sealRes.result as EncryptedBox }),
    );
    expect(openRes).toEqual({ id: "4", ok: true, result: payload });
  });

  it("setSessionKey resolves false (never throws) for a DEK wrapped to a different key tree", async () => {
    await init("1");
    const foreign = wrapDek(dek, deriveKeyTree(getRandomBytes(32)).content.publicKey);
    expect(await handler.handle(req("2", { type: "setSessionKey", wrappedDek: foreign }))).toEqual({
      id: "2",
      ok: true,
      result: false,
    });
  });

  describe("no PIN (Phase 5)", () => {
    it("a fresh worker loads its own key material with no user interaction", async () => {
      await init("1");

      const reborn = createCryptoWorkerHandler(storage, sessions);
      expect(await reborn.handle(req("2", { type: "ensureLoaded" }))).toEqual({
        id: "2",
        ok: true,
        result: true,
      });
      // …and is immediately usable, with no unlock step in between.
      expect(await reborn.handle(req("3", { type: "setSessionKey", wrappedDek }))).toEqual({
        id: "3",
        ok: true,
        result: true,
      });
    });

    it("records device mode when asked for prf WITHOUT a main-thread wrap key", async () => {
      // WebAuthn is not exposed to workers, so the worker can never derive this itself.
      // Recording "prf" here would produce a record nothing could ever unwrap.
      await handler.handle(
        req("1", {
          type: "init",
          masterSecret,
          refreshToken: "t",
          accountId: TEST_ACCOUNT_ID,
          mode: "prf",
        }),
      );
      const stored = await storage.load();
      if (stored?.v !== 2) throw new Error("unreachable");
      expect(stored.mode).toBe("device");
      expect(await handler.handle(req("2", { type: "ensureLoaded" }))).toMatchObject({
        result: true,
      });
    });

    it("honours prf mode when the main thread supplies the key, and needs it back to load", async () => {
      const wrapKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const credentialId = new Uint8Array([1, 2, 3, 4]);
      await handler.handle(
        req("1", {
          type: "init",
          masterSecret,
          refreshToken: "t",
          accountId: TEST_ACCOUNT_ID,
          mode: "prf",
          wrapKey,
          credentialId,
        }),
      );
      const stored = await storage.load();
      if (stored?.v !== 2) throw new Error("unreachable");
      expect(stored.mode).toBe("prf");
      expect(stored.wrapKey).toBeUndefined();

      const reborn = createCryptoWorkerHandler(storage, sessions);
      // Without the key: refuses, rather than falling back to something weaker.
      expect(await reborn.handle(req("2", { type: "ensureLoaded" }))).toMatchObject({
        result: false,
      });
      // With it: loads.
      expect(await reborn.handle(req("3", { type: "ensureLoaded", wrapKey }))).toMatchObject({
        result: true,
      });
    });

    it("describeStorage reports nothing before init", async () => {
      expect(await handler.handle(req("1", { type: "describeStorage" }))).toEqual({
        id: "1",
        ok: true,
        result: { present: false, version: 2, mode: null, credentialId: null },
      });
    });
  });

  // auth-ux-overhaul-fix-plan.md Fix 4: a key store slot is single-tenant, but nothing
  // recorded WHOSE keys were in it — signing into a second account on a browser that
  // already held a first account's keys silently loaded the wrong key tree. These pin the
  // account-scoped answers `describeStorage`/`getIdentity`/`ensureLoaded` now give.
  describe("account scoping (Fix 4)", () => {
    it("a record tagged for acct-A is invisible to acct-B: describeStorage, getIdentity, and ensureLoaded all refuse", async () => {
      const record: AnyStoredKeyRecord = {
        v: 2,
        accountId: "acct-A",
        mode: "device",
        wrapped: { nonce: new Uint8Array(12), ct: new Uint8Array(16) },
        signPubKey: encodeBase64(tree.signing.publicKey),
        contentPubKey: encodeBase64(tree.content.publicKey),
      };
      storage = createMemoryKeyStorage(record);
      handler = createCryptoWorkerHandler(storage, sessions);

      expect(
        await handler.handle(req("1", { type: "describeStorage", accountId: "acct-B" })),
      ).toEqual({
        id: "1",
        ok: true,
        result: { present: false, version: 2, mode: null, credentialId: null },
      });
      expect(await handler.handle(req("2", { type: "getIdentity", accountId: "acct-B" }))).toEqual({
        id: "2",
        ok: true,
        result: null,
      });
      expect(await handler.handle(req("3", { type: "ensureLoaded", accountId: "acct-B" }))).toEqual(
        { id: "3", ok: true, result: false },
      );
    });

    it("the same record queried by its own account (acct-A) succeeds on all three", async () => {
      const record: AnyStoredKeyRecord = {
        v: 2,
        accountId: "acct-A",
        mode: "device",
        wrapped: { nonce: new Uint8Array(12), ct: new Uint8Array(16) },
        signPubKey: encodeBase64(tree.signing.publicKey),
        contentPubKey: encodeBase64(tree.content.publicKey),
      };
      storage = createMemoryKeyStorage(record);
      handler = createCryptoWorkerHandler(storage, sessions);

      expect(
        await handler.handle(req("1", { type: "describeStorage", accountId: "acct-A" })),
      ).toMatchObject({ result: { present: true, version: 2, mode: "device" } });
      expect(
        await handler.handle(req("2", { type: "getIdentity", accountId: "acct-A" })),
      ).toMatchObject({ result: { signPubKey: expect.any(String) } });
    });

    it("an UNTAGGED (legacy) record is adopted by the first account that asks, and stamped on disk", async () => {
      await init("1", "acct-A"); // writes a tagged record via the normal init path
      const stored = await storage.load();
      if (stored?.v !== 2) throw new Error("unreachable");
      // Simulate a pre-Fix-4 record: strip the tag before a fresh worker loads it.
      const { accountId: _omit, ...untagged } = stored;
      storage = createMemoryKeyStorage(untagged as AnyStoredKeyRecord);
      const reborn = createCryptoWorkerHandler(storage, sessions);

      expect(
        await reborn.handle(req("2", { type: "describeStorage", accountId: "acct-B" })),
      ).toMatchObject({ result: { present: true } });
      expect(await reborn.handle(req("3", { type: "ensureLoaded", accountId: "acct-B" }))).toEqual({
        id: "3",
        ok: true,
        result: true,
      });

      const adopted = await storage.load();
      if (adopted?.v !== 2) throw new Error("unreachable");
      expect(adopted.accountId).toBe("acct-B");
    });

    it("getIdentity is permissive when the caller supplies no account id at all (today's behavior)", async () => {
      await init("1", "acct-A");
      expect(await handler.handle(req("2", { type: "getIdentity" }))).toMatchObject({
        result: { signPubKey: expect.any(String) },
      });
    });
  });

  describe("migration from a pre-Phase-5 PIN record", () => {
    async function seedV1(pin: string): Promise<void> {
      const record: AnyStoredKeyRecord = {
        wrapped: await wrapWithPin(masterSecret, pin),
        signPubKey: encodeBase64(tree.signing.publicKey),
        contentPubKey: encodeBase64(tree.content.publicKey),
        wrappedRefreshToken: await wrapWithPin(new TextEncoder().encode("old-refresh"), pin),
      };
      // The memory storage's save() is typed for v2; seed through a fresh instance.
      storage = createMemoryKeyStorage(record);
      handler = createCryptoWorkerHandler(storage, sessions);
    }

    it("is reported as version 1, NOT as ready", async () => {
      await seedV1("123456");
      expect(await handler.handle(req("1", { type: "describeStorage" }))).toEqual({
        id: "1",
        ok: true,
        result: { present: true, version: 1, mode: null, credentialId: null },
      });
      // The trap this replaces: `getIdentity` answers for a v1 record too, so using it as
      // the readiness check reported "ready" over a worker that could decrypt nothing.
      const identity = await handler.handle(req("2", { type: "getIdentity" }));
      expect(identity.ok && identity.result).not.toBeNull();
      expect(await handler.handle(req("3", { type: "ensureLoaded" }))).toMatchObject({
        result: false,
      });
    });

    it("upgrades on the right PIN and carries the session credential across", async () => {
      await seedV1("123456");
      expect(
        await handler.handle(req("1", { type: "migrateFromPin", pin: "123456", mode: "device" })),
      ).toEqual({ id: "1", ok: true, result: true });

      expect(await sessions.load()).toBe("old-refresh");
      const stored = await storage.load();
      expect(stored?.v).toBe(2);
      expect(await handler.handle(req("2", { type: "ensureLoaded" }))).toMatchObject({
        result: true,
      });
    });

    it("resolves false on a wrong PIN, leaving the record untouched", async () => {
      await seedV1("123456");
      expect(
        await handler.handle(req("1", { type: "migrateFromPin", pin: "000000", mode: "device" })),
      ).toEqual({ id: "1", ok: true, result: false });
      expect((await storage.load())?.v).toBeUndefined();
    });
  });

  describe("session credential (Phase 4a)", () => {
    it("persists a refresh token with NO key material present", async () => {
      // This is the whole point of splitting the stores: a browser with no keys must
      // still be able to hold a session, or it can never ask another device for keys.
      expect(
        await handler.handle(req("1", { type: "setRefreshToken", refreshToken: "r1" })),
      ).toEqual({ id: "1", ok: true, result: null });
      expect(await sessions.load()).toBe("r1");
    });

    it("clear() wipes the session store as well as the key store", async () => {
      await init("1");
      await handler.handle(req("2", { type: "clear" }));
      expect(await storage.load()).toBeNull();
      expect(await sessions.load()).toBeNull();
    });

    // auth-ux-overhaul-fix-plan.md Fix 5 / E2E-5.5: `clear()` only emptied the object
    // store, leaving `falcon-crypto-bridge`/`falcon-session` enumerable by
    // `indexedDB.databases()` after logout. The `"clear"` RPC must call `destroy()` on
    // both stores (which removes the database itself), not `clear()`.
    it('the "clear" RPC calls destroy() on both stores, not clear()', async () => {
      await init("1");
      const storageDestroy = vi.spyOn(storage, "destroy");
      const storageClear = vi.spyOn(storage, "clear");
      const sessionsDestroy = vi.spyOn(sessions, "destroy");
      const sessionsClear = vi.spyOn(sessions, "clear");

      await handler.handle(req("2", { type: "clear" }));

      expect(storageDestroy).toHaveBeenCalledOnce();
      expect(sessionsDestroy).toHaveBeenCalledOnce();
      expect(storageClear).not.toHaveBeenCalled();
      expect(sessionsClear).not.toHaveBeenCalled();
    });
  });

  describe("device-to-device key sharing (Phase 4)", () => {
    it("round-trips the master secret between two workers", async () => {
      await init("1");

      const requester = createCryptoWorkerHandler(
        createMemoryKeyStorage(),
        createMemorySessionStorage(),
      );
      const begun = await requester.handle(req("2", { type: "beginKeyRequest" }));
      expect(begun.ok).toBe(true);
      if (!begun.ok) throw new Error("unreachable");
      const ephPub = begun.result as string;

      const sealed = await handler.handle(req("3", { type: "sealKeysForPeer", ephPub }));
      expect(sealed.ok).toBe(true);
      if (!sealed.ok) throw new Error("unreachable");

      expect(
        await requester.handle(
          req("4", {
            type: "acceptKeyResponse",
            sealed: sealed.result as string,
            mode: "device",
          }),
        ),
      ).toEqual({ id: "4", ok: true, result: true });

      // The requester now derives the SAME content key, so it can open the holder's DEK.
      expect(await requester.handle(req("5", { type: "setSessionKey", wrappedDek }))).toEqual({
        id: "5",
        ok: true,
        result: true,
      });
    });

    it("keeps concurrent requests independent", async () => {
      // A single pending slot would let the second request destroy the first's secret
      // while its claim still consumed the sealed box server-side.
      await init("1");
      const requester = createCryptoWorkerHandler(
        createMemoryKeyStorage(),
        createMemorySessionStorage(),
      );
      const first = await requester.handle(req("2", { type: "beginKeyRequest" }));
      const second = await requester.handle(req("3", { type: "beginKeyRequest" }));
      if (!first.ok || !second.ok) throw new Error("unreachable");
      expect(first.result).not.toBe(second.result);

      const sealed = await handler.handle(
        req("4", { type: "sealKeysForPeer", ephPub: first.result as string }),
      );
      if (!sealed.ok) throw new Error("unreachable");

      // The FIRST request's secret still works even though a second was started after it.
      expect(
        await requester.handle(
          req("5", {
            type: "acceptKeyResponse",
            sealed: sealed.result as string,
            mode: "device",
          }),
        ),
      ).toMatchObject({ result: true });
    });

    it("rejects a box sealed to a foreign ephemeral key", async () => {
      await ready;
      const requester = createCryptoWorkerHandler(
        createMemoryKeyStorage(),
        createMemorySessionStorage(),
      );
      await requester.handle(req("1", { type: "beginKeyRequest" }));

      const foreign = generateEphemeralKeyPair();
      const payload = new Uint8Array(1 + 32);
      payload[0] = KEY_SHARE_PAYLOAD_VERSION;
      payload.set(masterSecret, 1);
      const sealedToForeign = encodeBase64(
        libsodiumEncryptForPublicKey(payload, foreign.publicKey),
      );

      expect(
        await requester.handle(
          req("2", {
            type: "acceptKeyResponse",
            sealed: sealedToForeign,
            mode: "device",
          }),
        ),
      ).toEqual({ id: "2", ok: true, result: false });
    });

    it("caps the number of in-flight requests", async () => {
      const requester = createCryptoWorkerHandler(
        createMemoryKeyStorage(),
        createMemorySessionStorage(),
      );
      for (let i = 0; i < 4; i++) {
        expect((await requester.handle(req(`${i}`, { type: "beginKeyRequest" }))).ok).toBe(true);
      }
      expect(await requester.handle(req("5", { type: "beginKeyRequest" }))).toEqual({
        id: "5",
        ok: false,
        error: "too-many-key-requests",
      });
    });

    it("refuses to seal keys it does not have", async () => {
      const { publicKey } = generateEphemeralKeyPair();
      expect(
        await handler.handle(
          req("1", { type: "sealKeysForPeer", ephPub: encodeBase64(publicKey) }),
        ),
      ).toEqual({ id: "1", ok: false, error: "needs-keys" });
    });
  });

  describe("CLI pairing", () => {
    it("sealForPeer produces a v1 payload the CLI can open", async () => {
      await init("1");
      const peer = generateEphemeralKeyPair();
      const res = await handler.handle(
        req("2", {
          type: "sealForPeer",
          ephPub: encodeBase64(peer.publicKey),
          refreshToken: "cli-refresh",
        }),
      );
      if (!res.ok) throw new Error("unreachable");

      const opened = libsodiumDecryptWithSecretKey(
        decodeBase64(res.result as string),
        peer.secretKey,
      );
      expect(opened).not.toBeNull();
      if (!opened) throw new Error("unreachable");
      expect(opened[0]).toBe(0x01);
      expect(opened.slice(1, 33)).toEqual(masterSecret);
      expect(new TextDecoder().decode(opened.slice(33))).toBe("cli-refresh");
    });
  });

  // auth-ux-overhaul-fix-plan.md Fix 2: never a bare `string | null` — collapsing "no
  // credential", "the server rejected it" and "the request never got anywhere" into one
  // falsy value is what turned an empty worker `API_URL` into a total sign-out on every
  // reload. There was previously NO test of `refreshSession` at all
  // (Phase-4a's "works in a fresh worker with no key material" case was never implemented
  // either — added below).
  describe("refreshSession (Phase 4a / Fix 2 tri-state)", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('resolves "no-credential" when nothing is stored to refresh with — a fresh worker, no key material needed', async () => {
      const res = await handler.handle(req("1", { type: "refreshSession" }));
      expect(res).toEqual({ id: "1", ok: true, result: { kind: "no-credential" } });
    });

    it('resolves "rejected" on a 401 — the only answer that should sign the user out', async () => {
      await sessions.save("dead-refresh-token");
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));

      const res = await handler.handle(req("1", { type: "refreshSession" }));
      expect(res).toEqual({ id: "1", ok: true, result: { kind: "rejected" } });
    });

    it('resolves "rejected" on a 403', async () => {
      await sessions.save("dead-refresh-token");
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));

      const res = await handler.handle(req("1", { type: "refreshSession" }));
      expect(res).toEqual({ id: "1", ok: true, result: { kind: "rejected" } });
    });

    it('resolves "unreachable" on a 404 — a misconfigured API base must NOT sign the user out', async () => {
      await sessions.save("some-refresh-token");
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

      const res = await handler.handle(req("1", { type: "refreshSession" }));
      expect(res).toEqual({ id: "1", ok: true, result: { kind: "unreachable" } });
    });

    it('resolves "unreachable" when the fetch itself throws (network down)', async () => {
      await sessions.save("some-refresh-token");
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

      const res = await handler.handle(req("1", { type: "refreshSession" }));
      expect(res).toEqual({ id: "1", ok: true, result: { kind: "unreachable" } });
    });

    it('resolves "unreachable" when the response body is not a recognisable refresh response', async () => {
      await sessions.save("some-refresh-token");
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

      const res = await handler.handle(req("1", { type: "refreshSession" }));
      expect(res).toEqual({ id: "1", ok: true, result: { kind: "unreachable" } });
    });

    it('resolves "ok" with a fresh access token and persists the rotated refresh token', async () => {
      await sessions.save("old-refresh-token");
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ accessToken: "fresh-access", refreshToken: "rotated-refresh" }),
            { status: 200 },
          ),
        );

      const res = await handler.handle(req("1", { type: "refreshSession" }));
      expect(res).toEqual({
        id: "1",
        ok: true,
        result: { kind: "ok", accessToken: "fresh-access" },
      });
      expect(await sessions.load()).toBe("rotated-refresh");
    });
  });

  it("bindKeysProof signs accountId‖contentPubKey‖nonce", async () => {
    await init("1");
    const nonce = encodeBase64(getRandomBytes(32));
    const res = await handler.handle(
      req("2", { type: "bindKeysProof", accountId: "acct-1", nonce }),
    );
    if (!res.ok) throw new Error("unreachable");
    const proof = res.result as { signPubKey: string; contentPubKey: string; signature: string };
    expect(proof.signPubKey).toBe(encodeBase64(tree.signing.publicKey));
    expect(proof.contentPubKey).toBe(encodeBase64(tree.content.publicKey));
    expect(decodeBase64(proof.signature).length).toBe(64);
  });
});
