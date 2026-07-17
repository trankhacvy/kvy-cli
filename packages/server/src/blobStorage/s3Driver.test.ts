/**
 * Unit coverage for `createS3Driver` itself (the one blob-storage file that
 * was previously only exercised indirectly via `app/routes/blobs.test.ts`'s
 * hand-rolled `FakeS3Driver`). Mocks `@aws-sdk/client-s3` and
 * `@aws-sdk/s3-request-presigner` so we can assert the actual wiring this
 * driver is responsible for: bucket/key flow into `PutObjectCommand`/
 * `GetObjectCommand`, `forcePathStyle`/credentials/endpoint flow into the
 * `S3Client` constructor, and `urlExpirySeconds` flows into `getSignedUrl`'s
 * `expiresIn` — without making a real network call or depending on a live
 * S3-compatible endpoint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { S3ClientMock, PutObjectCommandMock, GetObjectCommandMock, getSignedUrlMock } = vi.hoisted(
  () => ({
    S3ClientMock: vi.fn(),
    PutObjectCommandMock: vi.fn((input: unknown) => ({ __command: "put", input })),
    GetObjectCommandMock: vi.fn((input: unknown) => ({ __command: "get", input })),
    getSignedUrlMock: vi.fn(),
  }),
);

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: S3ClientMock,
  PutObjectCommand: PutObjectCommandMock,
  GetObjectCommand: GetObjectCommandMock,
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

const { createS3Driver } = await import("./s3Driver.js");

describe("createS3Driver", () => {
  const config = {
    bucket: "falcon-blobs",
    region: "us-east-1",
    endpoint: "http://localhost:9000",
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "test-secret",
    forcePathStyle: true,
    urlExpirySeconds: 900,
  };

  beforeEach(() => {
    S3ClientMock.mockClear();
    PutObjectCommandMock.mockClear();
    GetObjectCommandMock.mockClear();
    getSignedUrlMock.mockReset();
    getSignedUrlMock.mockResolvedValue("https://example-signed-url.test/blob-1");
  });

  it("constructs the S3Client with region/endpoint/forcePathStyle/credentials from config", () => {
    createS3Driver(config);

    expect(S3ClientMock).toHaveBeenCalledTimes(1);
    expect(S3ClientMock).toHaveBeenCalledWith({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  });

  it("reports its kind as 's3'", () => {
    const driver = createS3Driver(config);
    expect(driver.kind).toBe("s3");
  });

  it("createUploadTarget builds a PutObjectCommand scoped to bucket+key and presigns it", async () => {
    const driver = createS3Driver(config);
    const target = await driver.createUploadTarget({
      key: "blob-1",
      size: 42,
      baseUrl: "https://api.falcon.dev",
    });

    expect(PutObjectCommandMock).toHaveBeenCalledWith({ Bucket: config.bucket, Key: "blob-1" });
    expect(GetObjectCommandMock).not.toHaveBeenCalled();

    expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
    const [clientArg, commandArg, optionsArg] = getSignedUrlMock.mock.calls[0]!;
    expect(commandArg).toEqual({
      __command: "put",
      input: { Bucket: config.bucket, Key: "blob-1" },
    });
    expect(optionsArg).toEqual({ expiresIn: config.urlExpirySeconds });
    // The same client instance the constructor produced is the one handed to getSignedUrl.
    expect(clientArg).toBe(S3ClientMock.mock.instances[0]);

    expect(target).toEqual({
      url: "https://example-signed-url.test/blob-1",
      method: "PUT",
      headers: {},
    });
  });

  it("createDownloadTarget builds a GetObjectCommand scoped to bucket+key and presigns it", async () => {
    const driver = createS3Driver(config);
    const target = await driver.createDownloadTarget({
      key: "blob-2",
      baseUrl: "https://api.falcon.dev",
    });

    expect(GetObjectCommandMock).toHaveBeenCalledWith({ Bucket: config.bucket, Key: "blob-2" });
    expect(PutObjectCommandMock).not.toHaveBeenCalled();

    expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
    const [, commandArg, optionsArg] = getSignedUrlMock.mock.calls[0]!;
    expect(commandArg).toEqual({
      __command: "get",
      input: { Bucket: config.bucket, Key: "blob-2" },
    });
    expect(optionsArg).toEqual({ expiresIn: config.urlExpirySeconds });

    expect(target).toEqual({
      url: "https://example-signed-url.test/blob-1",
      method: "GET",
      headers: {},
    });
  });

  it("different keys produce different presigned commands (no key bleed-through)", async () => {
    const driver = createS3Driver(config);
    await driver.createUploadTarget({ key: "blob-a", size: 1, baseUrl: "https://api.falcon.dev" });
    await driver.createUploadTarget({ key: "blob-b", size: 1, baseUrl: "https://api.falcon.dev" });

    expect(PutObjectCommandMock).toHaveBeenNthCalledWith(1, {
      Bucket: config.bucket,
      Key: "blob-a",
    });
    expect(PutObjectCommandMock).toHaveBeenNthCalledWith(2, {
      Bucket: config.bucket,
      Key: "blob-b",
    });
  });
});
