/**
 * Driver selection (kvy-system-design.md §6.5: "self-host … blobs fall
 * back to local disk when unset"). `env.S3_BUCKET` set ⇒ S3-compatible
 * driver (real AWS S3/R2 in prod, MinIO in self-host); unset ⇒ local-disk
 * driver. `config.ts`'s own refine already guarantees a set `S3_BUCKET`
 * always carries valid credentials alongside it, so this factory never has
 * to handle the "half-configured S3" case.
 */
import type { Env } from "../config.js";
import { createLocalDriver, type LocalDriverConfig } from "./localDriver.js";
import { createS3Driver } from "./s3Driver.js";
import type { BlobStorageDriver } from "./types.js";

/** Shared by `buildBlobStorage` (below) and `app/routes/blobs.ts`'s local-disk sink handlers, so both agree on the same dir/token-secret without duplicating the resolution logic. */
export function resolveLocalDriverConfig(env: Env): LocalDriverConfig {
  return {
    dir: env.BLOB_LOCAL_DIR,
    tokenSecret: env.BLOB_LOCAL_TOKEN_SECRET ?? env.KVY_MASTER_SECRET,
    urlExpirySeconds: env.BLOB_URL_EXPIRY_SECONDS,
  };
}

export function buildBlobStorage(env: Env): BlobStorageDriver {
  if (env.S3_BUCKET) {
    return createS3Driver({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      urlExpirySeconds: env.BLOB_URL_EXPIRY_SECONDS,
    });
  }

  return createLocalDriver(resolveLocalDriverConfig(env));
}

export type { BlobDownloadTarget, BlobStorageDriver, BlobUploadTarget } from "./types.js";
