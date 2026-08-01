import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalDriver,
  deleteLocalBlob,
  readLocalBlob,
  writeLocalBlob,
} from "./localDriver.js";
import { verifyBlobToken } from "./localToken.js";

describe("localDriver", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kvy-blob-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("write then read round-trips the same bytes", async () => {
    const bytes = Buffer.from("encrypted-blob-bytes");
    await writeLocalBlob(dir, "blob-1", bytes);
    const readBack = await readLocalBlob(dir, "blob-1");
    expect(readBack).toEqual(bytes);
  });

  it("reading a never-written blob returns null, not a throw", async () => {
    expect(await readLocalBlob(dir, "nope")).toBeNull();
  });

  it("deleting a blob makes it unreadable again", async () => {
    await writeLocalBlob(dir, "blob-1", Buffer.from("x"));
    await deleteLocalBlob(dir, "blob-1");
    expect(await readLocalBlob(dir, "blob-1")).toBeNull();
  });

  it("deleting a never-written blob is a silent no-op", async () => {
    await expect(deleteLocalBlob(dir, "nope")).resolves.toBeUndefined();
  });

  it("refuses a key that would escape the blob directory", async () => {
    await expect(writeLocalBlob(dir, "../../etc/passwd", Buffer.from("x"))).rejects.toThrow(
      /invalid blob key/,
    );
  });

  describe("createUploadTarget / createDownloadTarget", () => {
    const config = {
      dir: "/unused",
      tokenSecret: "test-secret-32-chars-minimum!!!!",
      urlExpirySeconds: 300,
    };

    it("mints an upload URL pointing at the local sink with a verifiable token", async () => {
      const driver = createLocalDriver(config);
      const target = await driver.createUploadTarget({
        key: "blob-1",
        size: 10,
        baseUrl: "https://api.kvy.dev",
      });
      expect(target.method).toBe("PUT");
      const url = new URL(target.url);
      expect(url.origin).toBe("https://api.kvy.dev");
      expect(url.pathname).toBe("/v1/blobs/local/blob-1");
      const token = url.searchParams.get("token")!;
      const exp = Number(url.searchParams.get("exp"));
      expect(verifyBlobToken(config.tokenSecret, "upload", "blob-1", exp, token)).toBe(true);
      // A download-scoped verification of the same token must fail — the
      // token is bound to its op, not just its key.
      expect(verifyBlobToken(config.tokenSecret, "download", "blob-1", exp, token)).toBe(false);
    });

    it("mints a download URL with an independently-scoped token", async () => {
      const driver = createLocalDriver(config);
      const target = await driver.createDownloadTarget({
        key: "blob-1",
        baseUrl: "https://api.kvy.dev",
      });
      expect(target.method).toBe("GET");
      const url = new URL(target.url);
      const token = url.searchParams.get("token")!;
      const exp = Number(url.searchParams.get("exp"));
      expect(verifyBlobToken(config.tokenSecret, "download", "blob-1", exp, token)).toBe(true);
    });

    it("URL-encodes a key that isn't already URL-safe", async () => {
      const driver = createLocalDriver(config);
      const target = await driver.createUploadTarget({
        key: "weird key/with slash",
        size: 1,
        baseUrl: "https://api.kvy.dev",
      });
      expect(new URL(target.url).pathname).toBe("/v1/blobs/local/weird%20key%2Fwith%20slash");
    });
  });
});
