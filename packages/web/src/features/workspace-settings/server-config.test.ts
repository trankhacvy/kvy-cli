import {
  decodeBase64,
  deriveKeyTree,
  encodeBase64,
  getRandomBytes,
  hashWorkspacePath,
  wrapDek,
} from "@kvy/crypto/web";
import type { EncryptedBox, WorkspaceRow } from "@kvy/wire";
import { describe, expect, it, vi } from "vitest";
import type { CryptoBridgeClient } from "@/crypto";
import { createCryptoBridgeClient } from "@/crypto";
import { createLoopbackWorker } from "@/crypto/__tests__/loopback.js";
import { createMemoryKeyStorage } from "@/crypto/key-storage.js";
import { createMemorySessionStorage } from "@/crypto/session-storage";
import { createCryptoWorkerHandler } from "@/crypto/worker-handler.js";
import type { PutWorkspaceMetadataCasResult } from "@/lib/api";
import { saveWorkspaceServerConfig } from "./server-config.js";

/** Real crypto bridge (loopback worker + in-memory key storage), same recipe as `use-session-metadata-write.test.ts`. `wrapForBridge` wraps a raw DEK to this bridge's own content public key, so tests can build a `WorkspaceRow.dek` the bridge can genuinely unwrap. */
async function createTestBridge(): Promise<{
  bridge: CryptoBridgeClient;
  wrapForBridge: (rawDek: Uint8Array) => Uint8Array;
  workspaceIndexKey: Uint8Array;
}> {
  const masterSecret = getRandomBytes(32);
  const tree = deriveKeyTree(masterSecret);
  const worker = createLoopbackWorker(
    createCryptoWorkerHandler(createMemoryKeyStorage(), createMemorySessionStorage()),
  );
  const bridge = createCryptoBridgeClient(worker);
  await bridge.init(masterSecret, "test-refresh-token", "acct-test", { mode: "device" });
  return {
    bridge,
    wrapForBridge: (rawDek) => wrapDek(rawDek, tree.content.publicKey),
    workspaceIndexKey: tree.workspaceIndexKey,
  };
}

function fakeWorkspaceRow(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    id: "ws-1",
    accountId: "acct-test",
    pathHash: "fake-path-hash",
    metadata: { value: { t: "enc", v: 1, c: "placeholder" }, version: 0 },
    dek: "placeholder-dek",
    ...overrides,
  };
}

describe("saveWorkspaceServerConfig", () => {
  it("no existing row: mints a fresh DEK and creates one via createWorkspace, keyed by pathHash (never the raw path)", async () => {
    const { bridge, workspaceIndexKey } = await createTestBridge();
    const created = fakeWorkspaceRow();
    const createWorkspace = vi.fn(
      async (_token: string, _body: { pathHash: string; metadata: EncryptedBox; dek: string }) =>
        created,
    );
    const putMetadataCas = vi.fn();

    const result = await saveWorkspaceServerConfig(
      { bridge, createWorkspace, putMetadataCas, token: "tok-1", path: "/work/project" },
      undefined,
      (current) => ({ ...current, baseRef: "main" }),
    );

    expect(result).toBe(created);
    expect(putMetadataCas).not.toHaveBeenCalled();
    expect(createWorkspace).toHaveBeenCalledExactlyOnceWith("tok-1", {
      pathHash: hashWorkspacePath(workspaceIndexKey, "/work/project"),
      metadata: expect.any(Object),
      dek: expect.any(String),
    });

    const call = createWorkspace.mock.calls[0];
    if (!call) throw new Error("createWorkspace was not called");
    const [, body] = call;
    expect(JSON.stringify(body)).not.toContain("/work/project");
    const unwrapped = await bridge.setSessionKey(decodeBase64(body.dek));
    expect(unwrapped).toBe(true);
    const opened = await bridge.open<{ baseRef: string; path: string }>(body.metadata);
    expect(opened).toEqual({ baseRef: "main", path: "/work/project" });
  });

  it("existing row: opens the current box under its own DEK, patches, and CAS-updates", async () => {
    const { bridge, wrapForBridge } = await createTestBridge();
    const wrappedDek = wrapForBridge(getRandomBytes(32));

    const unwrappedForSetup = await bridge.setSessionKey(wrappedDek);
    expect(unwrappedForSetup).toBe(true);
    const existing = fakeWorkspaceRow({
      dek: encodeBase64(wrappedDek),
      metadata: { value: await bridge.seal({ baseRef: "develop", remote: "origin" }), version: 3 },
    });

    const putMetadataCas = vi.fn(
      async (): Promise<PutWorkspaceMetadataCasResult> => ({ ok: true, version: 4 }),
    );
    const createWorkspace = vi.fn();

    const result = await saveWorkspaceServerConfig(
      { bridge, createWorkspace, putMetadataCas, token: "tok-1", path: "/work/project" },
      existing,
      (current) => ({ ...current, remote: "upstream" }),
    );

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(putMetadataCas).toHaveBeenCalledExactlyOnceWith("tok-1", "ws-1", {
      expectedVersion: 3,
      value: expect.any(Object),
    });
    expect(result.metadata.version).toBe(4);
    const opened = await bridge.open<{ baseRef: string; remote: string }>(result.metadata.value);
    expect(opened).toEqual({ baseRef: "develop", remote: "upstream" });
  });

  it("existing row: 409 conflict retries against the current box and converges", async () => {
    const { bridge, wrapForBridge } = await createTestBridge();
    const wrappedDek = wrapForBridge(getRandomBytes(32));
    const unwrapped = await bridge.setSessionKey(wrappedDek);
    expect(unwrapped).toBe(true);

    const initialValue = await bridge.seal({ baseRef: "main" });
    const conflictValue = await bridge.seal({ baseRef: "main", remote: "origin" });
    const existing = fakeWorkspaceRow({
      dek: encodeBase64(wrappedDek),
      metadata: { value: initialValue, version: 1 },
    });

    const putMetadataCas = vi
      .fn<(...args: unknown[]) => Promise<PutWorkspaceMetadataCasResult>>()
      .mockResolvedValueOnce({ ok: false, current: { value: conflictValue, version: 2 } })
      .mockResolvedValueOnce({ ok: true, version: 3 });

    const result = await saveWorkspaceServerConfig(
      { bridge, createWorkspace: vi.fn(), putMetadataCas, token: "tok-1", path: "/work/project" },
      existing,
      (current) => ({ ...current, baseRef: "develop" }),
    );

    expect(putMetadataCas).toHaveBeenCalledTimes(2);
    expect(result.metadata.version).toBe(3);
    const opened = await bridge.open<{ baseRef: string; remote: string }>(result.metadata.value);
    expect(opened).toEqual({ baseRef: "develop", remote: "origin" });
  });
});
