import { getRandomBytes, open, seal } from "@falcon/crypto";
import type { EncryptedBox } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import { createSessionMetadataUpdater } from "./sessionMetadata.js";

function readRequestBody(body: RequestInit["body"]): {
  expectedVersion: number;
  value: EncryptedBox;
} {
  if (typeof body !== "string") {
    throw new Error("expected JSON string body");
  }
  return JSON.parse(body) as { expectedVersion: number; value: EncryptedBox };
}

describe("createSessionMetadataUpdater", () => {
  it("writes the new model into session metadata", async () => {
    const dek = getRandomBytes(32);
    const calls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ version: 1 }), { status: 200 });
    };
    const updater = createSessionMetadataUpdater({
      sessionId: "sess_1",
      serverUrl: "http://server.test",
      token: "token_1",
      dek,
      metadata: { title: "Project", path: "/work/project", model: null },
      metadataVersion: 0,
      fetchImpl,
    });

    await updater.updateModel("opus");

    expect(calls).toHaveLength(1);
    const body = readRequestBody(calls[0]?.body);
    expect(body.expectedVersion).toBe(0);
    expect(open(body.value, dek)).toEqual({
      title: "Project",
      path: "/work/project",
      providerSessionId: null,
      model: "opus",
    });
  });

  it("retries on CAS conflict and preserves server-side metadata fields", async () => {
    const dek = getRandomBytes(32);
    const currentBox = seal(
      {
        title: "Project",
        path: "/work/project",
        providerSessionId: "prov_1",
        model: "sonnet",
      },
      dek,
    );
    const calls: RequestInit[] = [];
    const responses = [
      new Response(
        JSON.stringify({ current: { value: currentBox, version: 2 } }),
        { status: 409 },
      ),
      new Response(JSON.stringify({ version: 3 }), { status: 200 }),
    ];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      const response = responses.shift();
      if (!response) throw new Error("unexpected extra fetch call");
      return response;
    };
    const updater = createSessionMetadataUpdater({
      sessionId: "sess_1",
      serverUrl: "http://server.test",
      token: "token_1",
      dek,
      metadata: { title: "Project", path: "/work/project", model: null },
      metadataVersion: 0,
      fetchImpl,
    });

    await updater.updateModel("haiku");

    expect(calls).toHaveLength(2);
    const secondBody = readRequestBody(calls[1]?.body);
    expect(secondBody.expectedVersion).toBe(2);
    expect(open(secondBody.value, dek)).toEqual({
      title: "Project",
      path: "/work/project",
      providerSessionId: "prov_1",
      model: "haiku",
    });
  });

  it("preserves unknown metadata fields (e.g. the web's `pinned`) across an updateModel write", async () => {
    const dek = getRandomBytes(32);
    const calls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ version: 1 }), { status: 200 });
    };
    const updater = createSessionMetadataUpdater({
      sessionId: "sess_1",
      serverUrl: "http://server.test",
      token: "token_1",
      dek,
      metadata: {
        title: "Project",
        path: "/work/project",
        model: null,
        pinned: true,
        someFuture: "x",
      },
      metadataVersion: 0,
      fetchImpl,
    });

    await updater.updateModel("opus");

    expect(calls).toHaveLength(1);
    const body = readRequestBody(calls[0]?.body);
    expect(open(body.value, dek)).toEqual({
      title: "Project",
      path: "/work/project",
      providerSessionId: null,
      model: "opus",
      pinned: true,
      someFuture: "x",
    });
  });

  it("preserves a `pinned` field written by another client (the web) through the 409-reconcile path", async () => {
    const dek = getRandomBytes(32);
    // Simulates a concurrent web write: the box the server hands back on
    // conflict carries a `pinned` field this CLI module has never heard of.
    const currentBox = seal(
      {
        title: "Project",
        path: "/work/project",
        providerSessionId: "prov_1",
        model: "sonnet",
        pinned: true,
      },
      dek,
    );
    const calls: RequestInit[] = [];
    const responses = [
      new Response(
        JSON.stringify({ current: { value: currentBox, version: 2 } }),
        { status: 409 },
      ),
      new Response(JSON.stringify({ version: 3 }), { status: 200 }),
    ];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      const response = responses.shift();
      if (!response) throw new Error("unexpected extra fetch call");
      return response;
    };
    const updater = createSessionMetadataUpdater({
      sessionId: "sess_1",
      serverUrl: "http://server.test",
      token: "token_1",
      dek,
      metadata: { title: "Project", path: "/work/project", model: null },
      metadataVersion: 0,
      fetchImpl,
    });

    await updater.updateModel("haiku");

    expect(calls).toHaveLength(2);
    const secondBody = readRequestBody(calls[1]?.body);
    expect(open(secondBody.value, dek)).toEqual({
      title: "Project",
      path: "/work/project",
      providerSessionId: "prov_1",
      model: "haiku",
      pinned: true,
    });
  });
});
