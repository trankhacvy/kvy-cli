import { deriveKeyTree, encodeBase64, getRandomBytes, wrapDek } from "@kvy/crypto/web";
import type { EncryptedBox } from "@kvy/wire";
import { describe, expect, it, vi } from "vitest";
import type { CryptoBridgeClient } from "@/crypto";
import { createCryptoBridgeClient } from "@/crypto";
import { createLoopbackWorker } from "@/crypto/__tests__/loopback.js";
import { createMemoryKeyStorage } from "@/crypto/key-storage.js";
import { createMemorySessionStorage } from "@/crypto/session-storage";
import { createCryptoWorkerHandler } from "@/crypto/worker-handler.js";
import type { PutSessionMetadataCasResult } from "@/lib/api";
import { patchSessionMetadataCas } from "./use-session-metadata-write";

/**
 * A real crypto bridge (loopback worker + in-memory key storage, exactly
 * `crypto/__tests__/client.test.ts`'s own recipe) rather than a hand-rolled
 * fake — so these tests genuinely seal/open real ciphertext through the
 * same postMessage-shaped boundary the browser uses, and the 409 test's
 * "decrypt the final sealed payload and assert field-level convergence"
 * assertion is proving something real, not asserting against a mock's
 * return value.
 */
async function createTestBridge(): Promise<{ bridge: CryptoBridgeClient; dek: string }> {
  const masterSecret = getRandomBytes(32);
  const tree = deriveKeyTree(masterSecret);
  const rawDek = getRandomBytes(32);
  const wrappedDek = wrapDek(rawDek, tree.content.publicKey);

  const worker = createLoopbackWorker(
    createCryptoWorkerHandler(createMemoryKeyStorage(), createMemorySessionStorage()),
  );
  const bridge = createCryptoBridgeClient(worker);
  await bridge.init(masterSecret, "test-refresh-token", "acct-test", { mode: "device" });
  // Establish the active session key up front so fixture boxes below can be
  // sealed under it (mirroring a real prior write by another client) —
  // `patchSessionMetadataCas` re-sets the same key itself before its own
  // open/seal calls, which is an idempotent no-op against the same DEK.
  await bridge.setSessionKey(wrappedDek);
  return { bridge, dek: encodeBase64(wrappedDek) };
}

describe("patchSessionMetadataCas", () => {
  it("happy path: seals the patched plaintext and bumps the cache version", async () => {
    const { bridge, dek } = await createTestBridge();
    const initialValue = await bridge.seal({ title: "Old title", path: "/work/project" });

    const putCas = vi.fn(
      async (): Promise<PutSessionMetadataCasResult> => ({ ok: true, version: 2 }),
    );

    const result = await patchSessionMetadataCas(
      { bridge, putCas, token: "tok-1", sessionId: "sess-1", dek },
      { value: initialValue, version: 1 },
      (current) => ({ ...current, title: "New title" }),
    );

    expect(result.version).toBe(2);
    expect(putCas).toHaveBeenCalledWith("tok-1", "sess-1", {
      expectedVersion: 1,
      value: result.value,
    });
    const opened = await bridge.open<{ title: string; path: string }>(result.value);
    expect(opened).toEqual({ title: "New title", path: "/work/project" });
  });

  it("409 conflict: retries against the current box and converges (patch + concurrent foreign field both present)", async () => {
    const { bridge, dek } = await createTestBridge();
    const initialValue = await bridge.seal({ title: "Old title", path: "/work/project" });
    // Simulates a concurrent CLI write: the box the server hands back on
    // conflict carries a `model` field this rename mutation never touches.
    const conflictValue = await bridge.seal({
      title: "Old title",
      path: "/work/project",
      model: "opus",
    });

    const putCas = vi
      .fn<(...args: unknown[]) => Promise<PutSessionMetadataCasResult>>()
      .mockResolvedValueOnce({
        ok: false,
        current: { value: conflictValue, version: 2 },
      })
      .mockResolvedValueOnce({ ok: true, version: 3 });

    const result = await patchSessionMetadataCas(
      { bridge, putCas, token: "tok-1", sessionId: "sess-1", dek },
      { value: initialValue, version: 1 },
      (current) => ({ ...current, title: "New title" }),
    );

    expect(putCas).toHaveBeenCalledTimes(2);
    expect(result.version).toBe(3);
    const secondCallArgs = putCas.mock.calls[1] as [string, string, { expectedVersion: number }];
    expect(secondCallArgs[2].expectedVersion).toBe(2);

    const opened = await bridge.open<{ title: string; path: string; model: string }>(result.value);
    expect(opened).toEqual({ title: "New title", path: "/work/project", model: "opus" });
  });

  it("rejects visibly (and never seals a from-scratch object) when the box can't be opened", async () => {
    const { bridge, dek } = await createTestBridge();
    const garbageBox: EncryptedBox = { t: "enc", v: 1, c: "not-real-ciphertext" };
    const putCas = vi.fn();

    await expect(
      patchSessionMetadataCas(
        { bridge, putCas, token: "tok-1", sessionId: "sess-1", dek },
        { value: garbageBox, version: 1 },
        (current) => ({ ...current, title: "New title" }),
      ),
    ).rejects.toThrow(/could not decrypt/i);
    expect(putCas).not.toHaveBeenCalled();
  });

  it("rejects when setSessionKey fails to unwrap the DEK", async () => {
    const { bridge } = await createTestBridge();
    const initialValue = await bridge.seal({ title: "Old title", path: "/work/project" });
    const foreignDek = encodeBase64(getRandomBytes(48));
    const putCas = vi.fn();

    await expect(
      patchSessionMetadataCas(
        { bridge, putCas, token: "tok-1", sessionId: "sess-1", dek: foreignDek },
        { value: initialValue, version: 1 },
        (current) => current,
      ),
    ).rejects.toThrow(/unwrap/i);
    expect(putCas).not.toHaveBeenCalled();
  });

  it("exhausts its retry bound and rejects rather than looping forever against a perpetually-conflicting write", async () => {
    const { bridge, dek } = await createTestBridge();
    const initialValue = await bridge.seal({ title: "Old title", path: "/work/project" });

    const putCas = vi.fn(
      async (): Promise<PutSessionMetadataCasResult> => ({
        ok: false,
        current: { value: initialValue, version: 1 },
      }),
    );

    await expect(
      patchSessionMetadataCas(
        { bridge, putCas, token: "tok-1", sessionId: "sess-1", dek },
        { value: initialValue, version: 1 },
        (current) => ({ ...current, title: "New title" }),
      ),
    ).rejects.toThrow(/too many conflicting writes/i);
    expect(putCas).toHaveBeenCalledTimes(5);
  });
});
