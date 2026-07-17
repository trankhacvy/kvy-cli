import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalDriver } from "../../blobStorage/localDriver.js";
import type { BlobStorageDriver } from "../../blobStorage/types.js";
import { buildServer } from "../server.js";
import { createTestAccount, createTestDb } from "./testHelpers.js";

/** Minimal in-memory fake standing in for the S3 driver — asserts the route layer never needs to know which driver is behind `BlobStorageDriver`. */
class FakeS3Driver implements BlobStorageDriver {
  readonly kind = "s3" as const;
  readonly uploadCalls: Array<{ key: string; size: number }> = [];
  readonly downloadCalls: string[] = [];

  async createUploadTarget({ key, size }: { key: string; size: number }) {
    this.uploadCalls.push({ key, size });
    return {
      url: `https://fake-s3.example/${key}?sig=upload`,
      method: "PUT" as const,
      headers: {},
    };
  }

  async createDownloadTarget({ key }: { key: string }) {
    this.downloadCalls.push(key);
    return {
      url: `https://fake-s3.example/${key}?sig=download`,
      method: "GET" as const,
      headers: {},
    };
  }
}

describe("POST /v1/blobs/request-upload + request-download (S3-backed)", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let driver: FakeS3Driver;
  let authHeader: string;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    driver = new FakeS3Driver();
    app = await buildServer({ logger: false }, { db, blobStorage: driver });
    const account = await createTestAccount(db);
    authHeader = account.authHeader;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("rejects an unauthenticated request-upload", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-upload",
      payload: { size: 100, contentHash: "abc" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("mints a blob row + delegates to the driver for an upload target", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-upload",
      headers: { authorization: authHeader },
      payload: { size: 1234, contentHash: "deadbeef" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ method: "PUT", headers: {} });
    expect(typeof body.blobId).toBe("string");
    expect(body.uploadUrl).toBe(`https://fake-s3.example/${body.blobId}?sig=upload`);
    expect(driver.uploadCalls).toContainEqual({ key: body.blobId, size: 1234 });
  });

  it("rejects a blob over the configured size limit", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-upload",
      headers: { authorization: authHeader },
      payload: { size: 999_999_999_999, contentHash: "x" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s a request-upload for a sessionId the caller doesn't own", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-upload",
      headers: { authorization: authHeader },
      payload: { size: 10, contentHash: "x", sessionId: "not-a-real-session" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("round-trips a blobId through request-download to a driver-minted download URL", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-upload",
      headers: { authorization: authHeader },
      payload: { size: 42, contentHash: "cafebabe" },
    });
    const { blobId } = upload.json();

    const download = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-download",
      headers: { authorization: authHeader },
      payload: { blobId },
    });
    expect(download.statusCode).toBe(200);
    expect(download.json()).toMatchObject({
      downloadUrl: `https://fake-s3.example/${blobId}?sig=download`,
      method: "GET",
    });
  });

  it("404s request-download for a blob belonging to another account", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-upload",
      headers: { authorization: authHeader },
      payload: { size: 10, contentHash: "x" },
    });
    const { blobId } = upload.json();

    const otherAccount = await createTestAccount(db);
    const download = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-download",
      headers: { authorization: otherAccount.authHeader },
      payload: { blobId },
    });
    expect(download.statusCode).toBe(404);
  });

  it("404s request-download for an unknown blobId", async () => {
    const download = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-download",
      headers: { authorization: authHeader },
      payload: { blobId: "does-not-exist" },
    });
    expect(download.statusCode).toBe(404);
  });

  it("does not mount the local-disk sink routes when the S3 driver is active", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/blobs/local/anything" });
    expect(response.statusCode).toBe(404);
  });
});

describe("PUT/GET /v1/blobs/local/:id (local-disk driver end-to-end)", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let dir: string;
  let authHeader: string;
  const tokenSecret = "test-local-token-secret-32-chars!!";

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "falcon-blob-route-test-"));
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    const driver = createLocalDriver({ dir, tokenSecret, urlExpirySeconds: 300 });
    app = await buildServer(
      { logger: false },
      { db, blobStorage: driver, blobLocalConfig: { dir, tokenSecret, urlExpirySeconds: 300 } },
    );
    const account = await createTestAccount(db);
    authHeader = account.authHeader;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("uploads then downloads the exact same encrypted bytes through the full request-upload -> PUT -> request-download -> GET flow", async () => {
    const bytes = Buffer.from("this-would-be-encryptBlob-output");

    const uploadReq = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-upload",
      headers: { authorization: authHeader },
      payload: { size: bytes.length, contentHash: "irrelevant-to-server" },
    });
    expect(uploadReq.statusCode).toBe(200);
    const { blobId, uploadUrl } = uploadReq.json();
    const uploadPath = new URL(uploadUrl).pathname + new URL(uploadUrl).search;

    const putRes = await app.inject({
      method: "PUT",
      url: uploadPath,
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    expect(putRes.statusCode).toBe(200);

    const downloadReq = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-download",
      headers: { authorization: authHeader },
      payload: { blobId },
    });
    expect(downloadReq.statusCode).toBe(200);
    const { downloadUrl } = downloadReq.json();
    const downloadPath = new URL(downloadUrl).pathname + new URL(downloadUrl).search;

    const getRes = await app.inject({ method: "GET", url: downloadPath });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.rawPayload).toEqual(bytes);
  });

  it("rejects an upload PUT with an invalid token", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/blobs/local/some-id?op=upload&token=bogus&exp=99999999999999",
      payload: Buffer.from("x"),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an upload PUT whose body length doesn't match the declared size", async () => {
    const uploadReq = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-upload",
      headers: { authorization: authHeader },
      payload: { size: 5, contentHash: "x" },
    });
    const { uploadUrl } = uploadReq.json();
    const uploadPath = new URL(uploadUrl).pathname + new URL(uploadUrl).search;

    const putRes = await app.inject({
      method: "PUT",
      url: uploadPath,
      payload: Buffer.from("way too many bytes for the declared size"),
    });
    expect(putRes.statusCode).toBe(400);
  });

  it("404s a download GET for a blobId that was never uploaded", async () => {
    const downloadReq = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-download",
      headers: { authorization: authHeader },
      payload: { blobId: "never-uploaded" },
    });
    // request-download itself 404s first since the row doesn't exist.
    expect(downloadReq.statusCode).toBe(404);
  });

  it("rejects a download GET with a mismatched op (upload token reused for download)", async () => {
    const uploadReq = await app.inject({
      method: "POST",
      url: "/v1/blobs/request-upload",
      headers: { authorization: authHeader },
      payload: { size: 1, contentHash: "x" },
    });
    const { uploadUrl } = uploadReq.json();
    const uploadUrlObj = new URL(uploadUrl);
    const swapped = `/v1/blobs/local/${uploadUrlObj.pathname.split("/").pop()}?op=download&token=${uploadUrlObj.searchParams.get("token")}&exp=${uploadUrlObj.searchParams.get("exp")}`;

    const response = await app.inject({ method: "GET", url: swapped });
    expect(response.statusCode).toBe(401);
  });
});
