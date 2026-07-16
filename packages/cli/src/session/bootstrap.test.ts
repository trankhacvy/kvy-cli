import {
  decodeBase64,
  deriveKeyTree,
  encodeBase64,
  getRandomBytes,
  open,
  unwrapDek,
  wrapDek,
} from "@falcon/crypto";
import type { EncryptedBox, SessionRow } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import {
  type BootstrapSessionDeps,
  type BootstrapSessionParams,
  bootstrapSession,
  buildSessionTag,
  createBootstrapSessionDeps,
} from "./bootstrap.js";

function fakeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess_1",
    accountId: "acc_1",
    workspaceId: null,
    machineId: "machine-1",
    tag: "tag-1",
    provider: "claude-code",
    executionTarget: "local",
    status: "active",
    metadata: { value: { t: "enc", v: 1, c: "" }, version: 0 },
    agentState: null,
    dek: encodeBase64(getRandomBytes(32)),
    msgSeq: 0,
    notificationsMuted: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function fakeFetch(response: { status: number; body: unknown }): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

function baseParams(overrides: Partial<BootstrapSessionParams> = {}): BootstrapSessionParams {
  const contentKeyPair = deriveKeyTree(getRandomBytes(32)).content;
  return {
    machineId: "machine-1",
    workspacePath: "/home/user/project",
    nonce: "nonce-1",
    provider: "claude-code",
    contentKeyPair,
    metadata: { title: "my session", path: "/home/user/project" },
    ...overrides,
  };
}

describe("buildSessionTag", () => {
  it("is deterministic for the same machineId/workspacePath/nonce triple", () => {
    const input = { machineId: "m1", workspacePath: "/a/b", nonce: "n1" };
    expect(buildSessionTag(input)).toBe(buildSessionTag({ ...input }));
  });

  it("produces a 64-char hex digest (sha256)", () => {
    const tag = buildSessionTag({ machineId: "m1", workspacePath: "/a/b", nonce: "n1" });
    expect(tag).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when machineId changes", () => {
    const base = { machineId: "m1", workspacePath: "/a/b", nonce: "n1" };
    expect(buildSessionTag(base)).not.toBe(buildSessionTag({ ...base, machineId: "m2" }));
  });

  it("differs when workspacePath changes", () => {
    const base = { machineId: "m1", workspacePath: "/a/b", nonce: "n1" };
    expect(buildSessionTag(base)).not.toBe(buildSessionTag({ ...base, workspacePath: "/a/c" }));
  });

  it("differs when nonce changes", () => {
    const base = { machineId: "m1", workspacePath: "/a/b", nonce: "n1" };
    expect(buildSessionTag(base)).not.toBe(buildSessionTag({ ...base, nonce: "n2" }));
  });

  it("does not collide across the machineId/workspacePath boundary", () => {
    // Without a separator, ("a","bc") and ("ab","c") would hash identically.
    const tagA = buildSessionTag({ machineId: "a", workspacePath: "bc", nonce: "n" });
    const tagB = buildSessionTag({ machineId: "ab", workspacePath: "c", nonce: "n" });
    expect(tagA).not.toBe(tagB);
  });
});

describe("createBootstrapSessionDeps", () => {
  it("defaults serverUrl and fetchImpl, keeps the supplied getAuthToken", () => {
    const getAuthToken = () => "token";
    const deps = createBootstrapSessionDeps({ getAuthToken });
    expect(deps.serverUrl).toBe("http://127.0.0.1:3005");
    expect(deps.fetchImpl).toBe(fetch);
    expect(deps.getAuthToken).toBe(getAuthToken);
  });

  it("lets overrides win", () => {
    const deps = createBootstrapSessionDeps({
      getAuthToken: () => "token",
      serverUrl: "http://example.test",
    });
    expect(deps.serverUrl).toBe("http://example.test");
  });
});

describe("bootstrapSession", () => {
  it("mints a DEK, wraps it to the content public key, and sends it on create (201)", async () => {
    const params = baseParams();
    const row = fakeSessionRow({ tag: buildSessionTag(params) });
    const fetchImpl = fakeFetch({ status: 201, body: row });
    const deps: BootstrapSessionDeps = {
      serverUrl: "http://server.test",
      fetchImpl,
      getAuthToken: () => "test-token",
    };

    const result = await bootstrapSession(deps, params);

    expect(result.created).toBe(true);
    expect(result.sessionId).toBe(row.id);
    expect(result.tag).toBe(buildSessionTag(params));
    expect(result.dek).toHaveLength(32);

    // Round-trip: the wrapped DEK sent to the server unwraps back to the
    // exact DEK this call returned to the caller.
    const [, requestInit] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(requestInit.method).toBe("POST");
    expect((requestInit.headers as Record<string, string>).authorization).toBe("Bearer test-token");
    const sentBody = JSON.parse(requestInit.body as string);
    expect(sentBody.tag).toBe(result.tag);
    expect(sentBody.provider).toBe("claude-code");
    expect(sentBody.machineId).toBe("machine-1");

    const wrappedDek = decodeBase64(sentBody.dek);
    const unwrapped = unwrapDek(wrappedDek, params.contentKeyPair.secretKey);
    expect(unwrapped).toEqual(result.dek);

    // The metadata EncryptedBox sent to the server decrypts under the
    // returned DEK to the title/path/providerSessionId placeholder.
    const opened = open<{ title: string; path: string; providerSessionId: string | null }>(
      sentBody.metadata as EncryptedBox,
      result.dek,
    );
    expect(opened).toEqual({
      title: "my session",
      path: "/home/user/project",
      providerSessionId: null,
    });
  });

  it("recovers the original DEK on an idempotent replay (created: false)", async () => {
    const params = baseParams();
    const tag = buildSessionTag(params);

    // Simulate a pre-existing row whose DEK was wrapped to the same content
    // key on a prior call, distinct from whatever this call freshly mints.
    const originalDek = getRandomBytes(32);
    const existingRow = fakeSessionRow({
      id: "sess_existing",
      tag,
      dek: encodeBase64(wrapDek(originalDek, params.contentKeyPair.publicKey)),
    });
    const fetchImpl = fakeFetch({ status: 200, body: existingRow });
    const deps: BootstrapSessionDeps = {
      serverUrl: "http://server.test",
      fetchImpl,
      getAuthToken: () => "test-token",
    };

    const result = await bootstrapSession(deps, params);

    expect(result.created).toBe(false);
    expect(result.sessionId).toBe("sess_existing");
    expect(result.dek).toEqual(originalDek);
  });

  it("throws when the server responds with a non-2xx status", async () => {
    const params = baseParams();
    const fetchImpl = fakeFetch({ status: 500, body: { error: "boom" } });
    const deps: BootstrapSessionDeps = {
      serverUrl: "http://server.test",
      fetchImpl,
      getAuthToken: () => "test-token",
    };

    await expect(bootstrapSession(deps, params)).rejects.toThrow(/responded 500/);
  });

  it("throws (does not swallow) when the network call itself fails", async () => {
    const params = baseParams();
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const deps: BootstrapSessionDeps = {
      serverUrl: "http://server.test",
      fetchImpl,
      getAuthToken: () => "test-token",
    };

    await expect(bootstrapSession(deps, params)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("throws if the existing row's DEK cannot be unwrapped with the supplied content key", async () => {
    const params = baseParams();
    const tag = buildSessionTag(params);
    const wrongKeyPair = deriveKeyTree(getRandomBytes(32)).content;
    const existingRow = fakeSessionRow({
      id: "sess_existing",
      tag,
      dek: encodeBase64(wrapDek(getRandomBytes(32), wrongKeyPair.publicKey)),
    });
    const fetchImpl = fakeFetch({ status: 200, body: existingRow });
    const deps: BootstrapSessionDeps = {
      serverUrl: "http://server.test",
      fetchImpl,
      getAuthToken: () => "test-token",
    };

    await expect(bootstrapSession(deps, params)).rejects.toThrow(/could not unwrap/);
  });
});
