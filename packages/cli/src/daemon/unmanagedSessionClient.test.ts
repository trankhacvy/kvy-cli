import { deriveKeyTree, getRandomBytes, open, unwrapDek } from "@kvy/crypto";
import type { EncryptedBox } from "@kvy/wire";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import {
  createUnmanagedSessionClientDeps,
  type UnmanagedSessionClientDeps,
  upsertUnmanagedSession,
} from "./unmanagedSessionClient.js";

function fakeFetch(status: number, body: unknown = {}): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

function collectingLogger(): { logger: Logger; warnings: unknown[] } {
  const warnings: unknown[] = [];
  return {
    warnings,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message, meta) => warnings.push({ message, meta }),
      error: () => {},
    },
  };
}

function baseDeps(overrides: Partial<UnmanagedSessionClientDeps> = {}): UnmanagedSessionClientDeps {
  const contentKeyPair = deriveKeyTree(getRandomBytes(32)).content;
  return createUnmanagedSessionClientDeps(
    { getAccessToken: async () => "test-token", contentPublicKey: contentKeyPair.publicKey },
    { serverUrl: "http://server.test", fetchImpl: fakeFetch(201), ...overrides },
  );
}

describe("upsertUnmanagedSession", () => {
  it("POSTs an encrypted summary sealed under a fresh DEK, wrapped to the content public key", async () => {
    const contentKeyPair = deriveKeyTree(getRandomBytes(32)).content;
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({}), { status: 201 });
    }) as unknown as typeof fetch;

    const deps = createUnmanagedSessionClientDeps(
      { getAccessToken: async () => "tok-1", contentPublicKey: contentKeyPair.publicKey },
      { serverUrl: "http://server.test", fetchImpl },
    );

    const ok = await upsertUnmanagedSession(deps, {
      machineId: "machine-1",
      workspaceId: "ws-1",
      providerRef: "session-abc",
      summary: { title: "Fix the bug", lastActivity: 12345, running: true },
    });

    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://server.test/v1/unmanaged-sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer tok-1" }),
      }),
    );

    const body = capturedBody as unknown as {
      machineId: string;
      workspaceId: string;
      providerRef: string;
      summary: EncryptedBox;
      dek: string;
    };
    expect(body.machineId).toBe("machine-1");
    expect(body.workspaceId).toBe("ws-1");
    expect(body.providerRef).toBe("session-abc");

    // The DEK the summary is sealed under must be recoverable via the
    // content secret key, and unwrap it to the exact plaintext sent.
    const dek = unwrapDek(
      Uint8Array.from(Buffer.from(body.dek, "base64")),
      contentKeyPair.secretKey,
    );
    expect(dek).not.toBeNull();
    const plaintext = open<{ title: string; lastActivity: number; running: boolean }>(
      body.summary,
      dek as Uint8Array,
    );
    expect(plaintext).toEqual({ title: "Fix the bug", lastActivity: 12345, running: true });
  });

  it("resolves false and logs a warning on a non-2xx response", async () => {
    const { logger, warnings } = collectingLogger();
    const deps = baseDeps({ fetchImpl: fakeFetch(404, { error: "not found" }), logger });

    const ok = await upsertUnmanagedSession(deps, {
      machineId: "machine-1",
      workspaceId: "ws-1",
      providerRef: "session-abc",
      summary: { title: "t", lastActivity: 1, running: false },
    });

    expect(ok).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it("resolves false and logs a warning when the network call throws", async () => {
    const { logger, warnings } = collectingLogger();
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const deps = baseDeps({ fetchImpl, logger });

    const ok = await upsertUnmanagedSession(deps, {
      machineId: "machine-1",
      workspaceId: "ws-1",
      providerRef: "session-abc",
      summary: { title: "t", lastActivity: 1, running: false },
    });

    expect(ok).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});
