/**
 * Downloads a `cli-latest` release asset plus its `.sha256` sidecar
 * (`scripts/build-binaries.sh` emits both for every binary) and verifies
 * the checksum before handing the bytes back — same trust model
 * `scripts/install.sh` already applies to the `curl | sh` path, reused here
 * so the CLI's own self-update path never installs an unverified download.
 */
import { createHash } from "node:crypto";
import { releaseAssetUrl, UPDATE_DOWNLOAD_TIMEOUT_MS } from "./config.js";
import type { FetchImpl } from "./fetchLatestVersion.js";

export class DownloadVerificationError extends Error {}

async function fetchBytes(url: string, fetchImpl: FetchImpl, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      throw new DownloadVerificationError(`download failed: ${url} (HTTP ${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** Parses a `sha256sum`/`shasum -a 256` formatted sidecar ("<hex>  <filename>\n") down to just the hex digest. */
function parseChecksumFile(contents: string): string {
  const hex = contents.trim().split(/\s+/)[0] ?? "";
  return hex.toLowerCase();
}

export interface DownloadAndVerifyOptions {
  repo: string;
  assetName: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/** Downloads `assetName` + `assetName.sha256` from the `cli-latest` release and returns the verified bytes. Throws `DownloadVerificationError` on any HTTP failure or checksum mismatch — never returns a payload that failed verification. */
export async function downloadAndVerify(options: DownloadAndVerifyOptions): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? UPDATE_DOWNLOAD_TIMEOUT_MS;

  const [bytes, checksumBytes] = await Promise.all([
    fetchBytes(releaseAssetUrl(options.repo, options.assetName), fetchImpl, timeoutMs),
    fetchBytes(releaseAssetUrl(options.repo, `${options.assetName}.sha256`), fetchImpl, timeoutMs),
  ]);

  const expected = parseChecksumFile(checksumBytes.toString("utf8"));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!expected || actual !== expected) {
    throw new DownloadVerificationError(
      `checksum mismatch for ${options.assetName}: expected ${expected || "(unreadable)"}, got ${actual}`,
    );
  }

  return bytes;
}
