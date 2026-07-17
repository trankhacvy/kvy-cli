import { z } from "zod";

/**
 * `POST /v1/blobs/request-upload` / `POST /v1/blobs/request-download`
 * (falcon-system-design.md §6.2, §6.5; plan.md §16 "4.3 Distribution &
 * self-host"). The server never sees blob plaintext — callers encrypt with
 * `encryptBlob`/a session-or-machine-DEK-derived blob key
 * (`deriveBlobKey`, design §5.1) *before* requesting an upload target, and
 * decrypt after downloading. These two routes only hand out short-lived
 * upload/download targets and record accounting metadata (`blobs` table:
 * size, contentHash, owner) — same "bookkeeping only" posture as every
 * other server-blind table.
 *
 * Two storage drivers exist behind the same contract (`packages/server/src/
 * blobStorage/`): S3-compatible (prod/self-host-with-MinIO) hands back a
 * real presigned URL; local-disk (self-host with no S3 configured) hands
 * back a URL pointing at this server's own `/v1/blobs/local/:id` sink,
 * signed with a short-lived HMAC token instead of SigV4. Callers treat both
 * identically: `PUT` the encrypted bytes to `uploadUrl` with `headers`
 * attached (empty for a plain presigned S3 PUT, `{authorization}` for the
 * local driver's self-hosted sink), `GET downloadUrl` the same way.
 */
export const BlobRequestUploadBodySchema = z.object({
  /** Encrypted-blob byte length (post `encryptBlob`), enforced against `BLOB_MAX_SIZE_BYTES` server-side. */
  size: z.number().int().positive(),
  /** SHA-256 of the encrypted bytes, hex — accounting/integrity metadata only, never used to derive anything. */
  contentHash: z.string().min(1),
  /** The session this blob belongs to, if any (git-diff/transcript-mirror blobs have none — machine-scoped). */
  sessionId: z.string().optional(),
});
export type BlobRequestUploadBody = z.infer<typeof BlobRequestUploadBodySchema>;

export const BlobRequestUploadResultSchema = z.object({
  /** The `blobs.id` row — this is the `blobRef` callers embed in `GitDiffResult`/`AdoptMirrorResult`/file-attachment envelopes. */
  blobId: z.string(),
  uploadUrl: z.string(),
  method: z.enum(["PUT"]),
  /** Extra headers the caller must attach to the `PUT` (e.g. the local driver's bearer token). Empty for a plain presigned S3 PUT. */
  headers: z.record(z.string(), z.string()),
});
export type BlobRequestUploadResult = z.infer<typeof BlobRequestUploadResultSchema>;

export const BlobRequestDownloadBodySchema = z.object({
  blobId: z.string(),
});
export type BlobRequestDownloadBody = z.infer<typeof BlobRequestDownloadBodySchema>;

export const BlobRequestDownloadResultSchema = z.object({
  downloadUrl: z.string(),
  method: z.enum(["GET"]),
  headers: z.record(z.string(), z.string()),
});
export type BlobRequestDownloadResult = z.infer<typeof BlobRequestDownloadResultSchema>;
