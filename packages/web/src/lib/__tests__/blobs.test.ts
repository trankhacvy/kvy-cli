import { afterEach, describe, expect, it, vi } from "vitest";
import type { CryptoBridgeClient } from "@/crypto";

const { requestBlobUploadMock, requestBlobDownloadMock } = vi.hoisted(() => ({
  requestBlobUploadMock: vi.fn(),
  requestBlobDownloadMock: vi.fn(),
}));

vi.mock("../api.js", () => ({
  requestBlobUpload: requestBlobUploadMock,
  requestBlobDownload: requestBlobDownloadMock,
}));

const { downloadAttachment, uploadAttachment } = await import("../blobs.js");

function fakeBridge(overrides: Partial<CryptoBridgeClient> = {}): CryptoBridgeClient {
  const notImplemented = () => {
    throw new Error("not implemented in this fake");
  };
  return {
    init: notImplemented,
    setSessionKey: notImplemented,
    createDek: notImplemented,
    seal: notImplemented,
    open: notImplemented,
    sealBlob: async (data) => new Uint8Array([0xff, ...data]), // trivial "encryption" marker
    openBlob: async (bundle) => (bundle[0] === 0xff ? bundle.subarray(1) : null),
    clear: notImplemented,
    describeStorage: notImplemented,
    ensureLoaded: notImplemented,
    migrateFromPin: notImplemented,
    beginKeyRequest: notImplemented,
    acceptKeyResponse: notImplemented,
    sealKeysForPeer: notImplemented,
    getIdentity: notImplemented,
    sealForPeer: notImplemented,
    bindKeysProof: notImplemented,
    setRefreshToken: notImplemented,
    refreshSession: notImplemented,
    terminate: () => {},
    ...overrides,
  };
}

describe("uploadAttachment", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    requestBlobUploadMock.mockReset();
    requestBlobDownloadMock.mockReset();
  });

  it("encrypts via the bridge, requests an upload target, PUTs the ciphertext, and returns the blobId", async () => {
    requestBlobUploadMock.mockResolvedValue({
      blobId: "blob-1",
      uploadUrl: "https://storage.test/blob-1",
      method: "PUT",
      headers: {},
    });
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const bridge = fakeBridge();
    const plaintext = new Uint8Array([1, 2, 3]);
    const blobId = await uploadAttachment("tok-1", bridge, plaintext, { sessionId: "sess-1" });

    expect(blobId).toBe("blob-1");
    expect(requestBlobUploadMock).toHaveBeenCalledWith("tok-1", {
      size: 4, // 1-byte marker + 3 plaintext bytes from the fake bridge
      contentHash: expect.any(String),
      sessionId: "sess-1",
    });
    expect(capturedUrl).toBe("https://storage.test/blob-1");
    expect(capturedInit?.method).toBe("PUT");
  });

  it("throws when the upload PUT is rejected", async () => {
    requestBlobUploadMock.mockResolvedValue({
      blobId: "blob-1",
      uploadUrl: "https://storage.test/blob-1",
      method: "PUT",
      headers: {},
    });
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 })) as typeof fetch;

    await expect(uploadAttachment("tok-1", fakeBridge(), new Uint8Array([1]))).rejects.toThrow(
      /upload failed/,
    );
  });
});

describe("downloadAttachment", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    requestBlobUploadMock.mockReset();
    requestBlobDownloadMock.mockReset();
  });

  it("requests a download target, GETs it, and decrypts via the bridge", async () => {
    requestBlobDownloadMock.mockResolvedValue({
      downloadUrl: "https://storage.test/blob-1",
      method: "GET",
      headers: {},
    });
    const encrypted = new Uint8Array([0xff, 9, 8, 7]);
    globalThis.fetch = vi.fn(
      async () => new Response(encrypted.slice().buffer as ArrayBuffer, { status: 200 }),
    ) as typeof fetch;

    const result = await downloadAttachment("tok-1", fakeBridge(), "blob-1");

    expect(result).toEqual(new Uint8Array([9, 8, 7]));
    expect(requestBlobDownloadMock).toHaveBeenCalledWith("tok-1", "blob-1");
  });

  it("throws when the download GET fails", async () => {
    requestBlobDownloadMock.mockResolvedValue({
      downloadUrl: "https://storage.test/blob-1",
      method: "GET",
      headers: {},
    });
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch;

    await expect(downloadAttachment("tok-1", fakeBridge(), "blob-1")).rejects.toThrow(
      /download failed/,
    );
  });

  it("resolves null when the bridge fails to decrypt the downloaded bytes", async () => {
    requestBlobDownloadMock.mockResolvedValue({
      downloadUrl: "https://storage.test/blob-1",
      method: "GET",
      headers: {},
    });
    globalThis.fetch = vi.fn(
      async () => new Response(new Uint8Array([0x00, 1, 2]).buffer as ArrayBuffer, { status: 200 }),
    ) as typeof fetch;

    const result = await downloadAttachment("tok-1", fakeBridge(), "blob-1");
    expect(result).toBeNull();
  });
});
