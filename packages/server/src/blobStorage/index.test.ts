import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same "mutate env, then dynamic re-import" pattern as config.test.ts —
// config.ts (and therefore buildBlobStorage's `Env` input) is parsed once
// at import time.
const ORIGINAL_ENV = { ...process.env };

async function importFresh() {
  vi.resetModules();
  const configMod = await import("../config.js");
  const blobStorageMod = await import("./index.js");
  return { env: configMod.env, buildBlobStorage: blobStorageMod.buildBlobStorage };
}

describe("buildBlobStorage driver selection", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("selects the local-disk driver when S3_BUCKET is unset", async () => {
    const { env, buildBlobStorage } = await importFresh();
    const driver = buildBlobStorage(env);
    expect(driver.kind).toBe("local");
  });

  it("selects the S3 driver when S3_BUCKET + credentials are set", async () => {
    process.env.S3_BUCKET = "falcon-blobs";
    process.env.S3_ACCESS_KEY_ID = "test-key";
    process.env.S3_SECRET_ACCESS_KEY = "test-secret";
    const { env, buildBlobStorage } = await importFresh();
    const driver = buildBlobStorage(env);
    expect(driver.kind).toBe("s3");
  });

  it("fails fast at config parse time when S3_BUCKET is set without credentials", async () => {
    process.env.S3_BUCKET = "falcon-blobs";
    await expect(importFresh()).rejects.toThrow(/S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/);
  });
});
