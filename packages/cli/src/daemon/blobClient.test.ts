import { decryptBlob, encryptBlob, getRandomBytes } from "@kvy/crypto";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import {
  type BlobClientDeps,
  createBlobClientDeps,
  downloadBlob,
  uploadBlob,
} from "./blobClient.js";

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

function baseDeps(overrides: Partial<BlobClientDeps> = {}): BlobClientDeps {
  return createBlobClientDeps(
    { getAccessToken: async () => "test-token" },
    { serverUrl: "http://server.test", ...overrides },
  );
}

describe("uploadBlob", () => {
  it("encrypts, requests an upload target, PUTs the ciphertext, and returns the blobId", async () => {
    const blobKey = getRandomBytes(32);
    const plaintext = new TextEncoder().encode("large diff contents");
    let capturedRequestUploadBody: Record<string, unknown> | null = null;
    let capturedPutBody: Buffer | null = null;

    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "http://server.test/v1/blobs/request-upload") {
        capturedRequestUploadBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            blobId: "blob-1",
            uploadUrl: "https://storage.test/blob-1",
            method: "PUT",
            headers: {},
          }),
          { status: 200 },
        );
      }
      if (url === "https://storage.test/blob-1") {
        capturedPutBody = init.body as Buffer;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const blobId = await uploadBlob(plaintext, blobKey, baseDeps({ fetchImpl }));

    expect(blobId).toBe("blob-1");
    expect(capturedRequestUploadBody).toMatchObject({ size: expect.any(Number) });
    expect(
      typeof (capturedRequestUploadBody as unknown as { contentHash: string }).contentHash,
    ).toBe("string");

    // The bytes actually PUT are `encryptBlob`'s output — decrypting them
    // under the same key must recover the original plaintext.
    expect(capturedPutBody).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by the not.toBeNull() assertion above
    const putBytes = new Uint8Array(capturedPutBody!);
    const decrypted = decryptBlob(putBytes, blobKey);
    expect(decrypted).toEqual(plaintext);
  });

  it("passes sessionId through to request-upload when provided", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/blobs/request-upload")) {
        capturedBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            blobId: "b1",
            uploadUrl: "https://s.test/b1",
            method: "PUT",
            headers: {},
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    await uploadBlob(new Uint8Array([1, 2, 3]), getRandomBytes(32), baseDeps({ fetchImpl }), {
      sessionId: "session-abc",
    });

    expect((capturedBody as unknown as { sessionId: string }).sessionId).toBe("session-abc");
  });

  it("resolves null and logs a warning when request-upload is rejected", async () => {
    const { logger, warnings } = collectingLogger();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "nope" }), { status: 400 }),
    ) as unknown as typeof fetch;

    const blobId = await uploadBlob(
      new Uint8Array([1]),
      getRandomBytes(32),
      baseDeps({ fetchImpl, logger }),
    );

    expect(blobId).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("resolves null and logs a warning when the upload PUT fails", async () => {
    const { logger, warnings } = collectingLogger();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/blobs/request-upload")) {
        return new Response(
          JSON.stringify({
            blobId: "b1",
            uploadUrl: "https://s.test/b1",
            method: "PUT",
            headers: {},
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;

    const blobId = await uploadBlob(
      new Uint8Array([1]),
      getRandomBytes(32),
      baseDeps({ fetchImpl, logger }),
    );

    expect(blobId).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("resolves null and logs a warning when the network throws", async () => {
    const { logger, warnings } = collectingLogger();
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const blobId = await uploadBlob(
      new Uint8Array([1]),
      getRandomBytes(32),
      baseDeps({ fetchImpl, logger }),
    );

    expect(blobId).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("resolves null when request-upload returns a malformed response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ blobId: 123 }), { status: 200 }),
    ) as unknown as typeof fetch;

    const blobId = await uploadBlob(
      new Uint8Array([1]),
      getRandomBytes(32),
      baseDeps({ fetchImpl }),
    );

    expect(blobId).toBeNull();
  });
});

describe("downloadBlob", () => {
  it("requests a download target, GETs it, and decrypts under the blob key", async () => {
    const blobKey = getRandomBytes(32);
    const plaintext = new TextEncoder().encode("hello blob");
    const encrypted = encryptBlob(plaintext, blobKey);

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/blobs/request-download")) {
        return new Response(
          JSON.stringify({
            downloadUrl: "https://storage.test/blob-1",
            method: "GET",
            headers: {},
          }),
          { status: 200 },
        );
      }
      if (url === "https://storage.test/blob-1") {
        return new Response(Buffer.from(encrypted), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const result = await downloadBlob("blob-1", blobKey, baseDeps({ fetchImpl }));

    expect(result).toEqual(plaintext);
  });

  it("resolves null when request-download 404s", async () => {
    const { logger, warnings } = collectingLogger();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 404 }),
    ) as unknown as typeof fetch;

    const result = await downloadBlob(
      "missing",
      getRandomBytes(32),
      baseDeps({ fetchImpl, logger }),
    );

    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("resolves null when the downloaded bytes fail to decrypt under the given key (wrong key)", async () => {
    const encrypted = encryptBlob(new Uint8Array([1, 2, 3]), getRandomBytes(32));
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/blobs/request-download")) {
        return new Response(
          JSON.stringify({
            downloadUrl: "https://storage.test/blob-1",
            method: "GET",
            headers: {},
          }),
          { status: 200 },
        );
      }
      return new Response(Buffer.from(encrypted), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await downloadBlob("blob-1", getRandomBytes(32), baseDeps({ fetchImpl }));

    expect(result).toBeNull();
  });
});
