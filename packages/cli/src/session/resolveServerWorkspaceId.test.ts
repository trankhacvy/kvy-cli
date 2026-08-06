import { deriveKeyTree, getRandomBytes, hashWorkspacePath } from "@kvy/crypto";
import type { WorkspaceRow } from "@kvy/wire";
import { describe, expect, it, vi } from "vitest";
import {
  type ResolveServerWorkspaceIdDeps,
  resolveServerWorkspaceId,
} from "./resolveServerWorkspaceId.js";

function fakeWorkspaceRow(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    id: "ws_1",
    accountId: "acc_1",
    pathHash: "fake-path-hash",
    metadata: { value: { t: "enc", v: 1, c: "" }, version: 0 },
    dek: "",
    ...overrides,
  };
}

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function baseDeps(
  overrides: Partial<ResolveServerWorkspaceIdDeps> = {},
): ResolveServerWorkspaceIdDeps {
  const { content, workspaceIndexKey } = deriveKeyTree(getRandomBytes(32));
  return {
    serverUrl: "https://api.kvy.invalid",
    fetchImpl: vi.fn(
      async () =>
        new Response(JSON.stringify(fakeWorkspaceRow()), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch,
    getAuthToken: () => "test-token",
    contentPublicKey: content.publicKey,
    workspaceIndexKey,
    logger: fakeLogger(),
    ...overrides,
  };
}

describe("resolveServerWorkspaceId", () => {
  it("returns the server's opaque workspace id, never the real path", async () => {
    const deps = baseDeps({
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify(fakeWorkspaceRow({ id: "ws_opaque_42" })), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch,
    });

    const result = await resolveServerWorkspaceId("/Users/alice/project", deps);

    expect(result).toBe("ws_opaque_42");
  });

  it("POSTs a pathHash that matches hashWorkspacePath, never the raw path itself", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(fakeWorkspaceRow()), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const deps = baseDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await resolveServerWorkspaceId("/Users/alice/project", deps);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.kvy.invalid/v1/workspaces",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.pathHash).toBe(hashWorkspacePath(deps.workspaceIndexKey, "/Users/alice/project"));
    expect(JSON.stringify(body)).not.toContain("/Users/alice/project");
  });

  it("is deterministic: the same path + key always produces the same pathHash across calls", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(fakeWorkspaceRow()), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const deps = baseDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await resolveServerWorkspaceId("/Users/alice/project", deps);
    await resolveServerWorkspaceId("/Users/alice/project", deps);

    const calls = fetchImpl.mock.calls as unknown as [string, { body: string }][];
    const bodies = calls.map((call) => JSON.parse(call[1].body).pathHash);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("returns null and logs a warning, never throws, on a non-2xx response", async () => {
    const logger = fakeLogger();
    const deps = baseDeps({
      fetchImpl: vi.fn(
        async () => new Response("server error", { status: 500 }),
      ) as unknown as typeof fetch,
      logger,
    });

    const result = await resolveServerWorkspaceId("/Users/alice/project", deps);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "[resolve-server-workspace-id] failed, continuing without workspaceId",
      expect.objectContaining({ message: expect.stringContaining("500") }),
    );
  });

  it("returns null, never throws, when fetch itself rejects (network failure)", async () => {
    const deps = baseDeps({
      fetchImpl: vi.fn(async () => {
        throw new Error("network unreachable");
      }) as unknown as typeof fetch,
    });

    const result = await resolveServerWorkspaceId("/Users/alice/project", deps);

    expect(result).toBeNull();
  });

  it("returns null when the response body doesn't match WorkspaceRowSchema", async () => {
    const deps = baseDeps({
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ unexpected: "shape" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch,
    });

    const result = await resolveServerWorkspaceId("/Users/alice/project", deps);

    expect(result).toBeNull();
  });
});
