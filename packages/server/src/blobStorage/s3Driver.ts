/**
 * S3-compatible (MinIO in dev/self-host, R2/S3 in prod)"). Presigned PUT/GET
 * only — the server itself never touches blob bytes, it just asks the S3
 * SDK to sign a time-limited URL the caller talks to directly. Works
 * unmodified against real AWS S3, Cloudflare R2, and MinIO (self-host) —
 * all speak the same presigned-URL S3 API; `forcePathStyle` is the one knob
 * MinIO/most non-AWS endpoints need (virtual-hosted-style bucket URLs
 * require real DNS wildcarding AWS/R2 provide and MinIO typically doesn't).
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { BlobDownloadTarget, BlobStorageDriver, BlobUploadTarget } from "./types.js";

export interface S3DriverConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Seconds the presigned URL stays valid. */
  urlExpirySeconds: number;
}

export function createS3Driver(config: S3DriverConfig): BlobStorageDriver {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    kind: "s3",
    async createUploadTarget({ key }): Promise<BlobUploadTarget> {
      const command = new PutObjectCommand({ Bucket: config.bucket, Key: key });
      const url = await getSignedUrl(client, command, { expiresIn: config.urlExpirySeconds });
      return { url, method: "PUT", headers: {} };
    },
    async createDownloadTarget({ key }): Promise<BlobDownloadTarget> {
      const command = new GetObjectCommand({ Bucket: config.bucket, Key: key });
      const url = await getSignedUrl(client, command, { expiresIn: config.urlExpirySeconds });
      return { url, method: "GET", headers: {} };
    },
  };
}
