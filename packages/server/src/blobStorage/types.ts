/**
 * "Prod: … S3/R2 … Self-host: … optional minio; blobs fall back to local
 * local-disk drivers"). Both drivers below (`s3Driver.ts`, `localDriver.ts`)
 * implement this same narrow surface so `app/routes/blobs.ts` never branches
 * on which one is active — see `index.ts`'s `buildBlobStorage` for how the
 * choice is made.
 *
 * Deliberately just two methods: mint an upload target, mint a download
 * target. Everything else (accounting, ownership, size caps) lives in the
 * `blobs` DB row and the route handler, not the driver — a driver's only
 * job is "hand back a URL the caller can PUT/GET encrypted bytes to/from",
 * matching the "server never sees plaintext" boundary (encryption already
 * happened client-side before any of this runs).
 */
export interface BlobUploadTarget {
  url: string;
  method: "PUT";
  /** Extra headers the caller must attach to the `PUT` request. Empty for a plain presigned S3 PUT. */
  headers: Record<string, string>;
}

export interface BlobDownloadTarget {
  url: string;
  method: "GET";
  headers: Record<string, string>;
}

export interface BlobStorageDriver {
  readonly kind: "s3" | "local";
  /**
   * `key` is the owning `blobs.id` row — stable, unguessable (cuid2),
   * already unique, so it doubles as the storage object key/filename with
   * no extra mapping table needed. `baseUrl` (e.g. `https://api.kvy-cli.tkvy.dev`,
   * no trailing slash) is only consumed by the local driver, which has to
   * build a URL pointing back at this same server; the S3 driver ignores it
   * entirely (its URL points at the S3-compatible endpoint instead).
   */
  createUploadTarget(params: {
    key: string;
    size: number;
    baseUrl: string;
  }): Promise<BlobUploadTarget>;
  createDownloadTarget(params: { key: string; baseUrl: string }): Promise<BlobDownloadTarget>;
}
