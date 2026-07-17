/**
 * Local-disk blob driver (falcon-system-design.md §6.5: "self-host …
 * optional minio; blobs fall back to local disk when unset"). No S3-
 * compatible endpoint to presign against, so this driver builds a URL
 * pointing back at this same server's own `/v1/blobs/local/:id` sink
 * (`app/routes/blobs.ts`), authorized by a short-lived HMAC token
 * (`localToken.ts`) embedded in the query string — the local equivalent of
 * an S3 presigned URL's SigV4 signature.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { signBlobToken } from "./localToken.js";
import type { BlobDownloadTarget, BlobStorageDriver, BlobUploadTarget } from "./types.js";

export interface LocalDriverConfig {
  dir: string;
  tokenSecret: string;
  urlExpirySeconds: number;
}

/** Resolves `key` to an absolute path inside `dir`, refusing anything that would escape it (CWE-22) — `key` is always a `blobs.id` cuid2 minted server-side, but this stays defense-in-depth rather than trusting that invariant blindly. */
function resolveBlobPath(dir: string, key: string): string {
  const resolved = path.resolve(dir, key);
  const resolvedDir = path.resolve(dir) + path.sep;
  if (!resolved.startsWith(resolvedDir)) {
    throw new Error(`localDriver: invalid blob key "${key}"`);
  }
  return resolved;
}

export function createLocalDriver(config: LocalDriverConfig): BlobStorageDriver {
  return {
    kind: "local",
    async createUploadTarget({ key, baseUrl }): Promise<BlobUploadTarget> {
      const { token, exp } = signBlobToken(
        config.tokenSecret,
        "upload",
        key,
        config.urlExpirySeconds,
      );
      const url = `${baseUrl}/v1/blobs/local/${encodeURIComponent(key)}?op=upload&token=${token}&exp=${exp}`;
      return { url, method: "PUT", headers: {} };
    },
    async createDownloadTarget({ key, baseUrl }): Promise<BlobDownloadTarget> {
      const { token, exp } = signBlobToken(
        config.tokenSecret,
        "download",
        key,
        config.urlExpirySeconds,
      );
      const url = `${baseUrl}/v1/blobs/local/${encodeURIComponent(key)}?op=download&token=${token}&exp=${exp}`;
      return { url, method: "GET", headers: {} };
    },
  };
}

/**
 * Writes `bytes` for `key` under `dir`, creating `dir` if needed. Writes to
 * a temp file and renames into place so a reader can never observe a
 * partially-written blob (same tmp-write-then-rename pattern the CLI's own
 * `persistence.ts` uses for local state).
 */
export async function writeLocalBlob(dir: string, key: string, bytes: Buffer): Promise<void> {
  await mkdir(dir, { recursive: true });
  const finalPath = resolveBlobPath(dir, key);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, bytes);
  await rename(tmpPath, finalPath);
}

/** Reads back a previously-written blob. Returns `null` if it doesn't exist (never written, or expired/cleaned up) rather than throwing — callers 404. */
export async function readLocalBlob(dir: string, key: string): Promise<Buffer | null> {
  try {
    return await readFile(resolveBlobPath(dir, key));
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Best-effort delete, used only by tests today; never throws on a missing file. */
export async function deleteLocalBlob(dir: string, key: string): Promise<void> {
  try {
    await unlink(resolveBlobPath(dir, key));
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
}
