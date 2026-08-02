/**
 * Daemon-side HTTP client for the blob storage subsystem. Encrypts with
 * `encryptBlob` before ever talking to the server — the server never sees
 * plaintext.
 *
 * Best-effort by design: every method resolves `null` (never throws) on any
 * network/HTTP/decode failure, logged at `warn`. A failed blob upload must
 * never crash the RPC handler that was about to fall back to inline delivery
 * anyway — it just doesn't get the `blobRef` efficiency win.
 */
import { createHash } from "node:crypto";
import { decryptBlob, encryptBlob } from "@kvy/crypto";
import type { Logger } from "../logger.js";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3005";
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 60_000;

export interface BlobClientDeps {
  serverUrl: string;
  /** Resolves a fresh access token per call — not a static string that goes stale. */
  getAccessToken: () => Promise<string | null>;
  /** Injectable so unit tests never make a real network call. */
  fetchImpl: typeof fetch;
  logger: Logger;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function createBlobClientDeps(
  required: Pick<BlobClientDeps, "getAccessToken">,
  overrides: Partial<BlobClientDeps> = {},
): BlobClientDeps {
  return {
    serverUrl: process.env.KVY_SERVER_URL?.trim() || DEFAULT_SERVER_URL,
    fetchImpl: fetch,
    logger: noopLogger,
    ...required,
    ...overrides,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchJson(
  deps: BlobClientDeps,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = (await deps.getAccessToken()) ?? "";
    const response = await deps.fetchImpl(`${deps.serverUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      deps.logger.warn("[blob-client] request rejected", { path, status: response.status, text });
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    deps.logger.warn("[blob-client] request failed", {
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Encrypts `plaintext` under `blobKey`, requests an upload target, then PUTs
 * the encrypted bytes. Returns the resulting `blobId`, or `null` on any failure
 * (see module-level never-throw contract).
 */
export async function uploadBlob(
  plaintext: Uint8Array,
  blobKey: Uint8Array,
  deps: BlobClientDeps,
  opts: { sessionId?: string } = {},
): Promise<string | null> {
  const encrypted = encryptBlob(plaintext, blobKey);
  const requested = await fetchJson(
    deps,
    "/v1/blobs/request-upload",
    { size: encrypted.length, contentHash: sha256Hex(encrypted), sessionId: opts.sessionId },
    REQUEST_TIMEOUT_MS,
  );
  if (!requested) return null;
  const { blobId, uploadUrl, method, headers } = requested;
  if (typeof blobId !== "string" || typeof uploadUrl !== "string" || method !== "PUT") {
    deps.logger.warn("[blob-client] request-upload returned an invalid response");
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const putResponse = await deps.fetchImpl(uploadUrl, {
      method: "PUT",
      headers: {
        ...(headers && typeof headers === "object" ? (headers as Record<string, string>) : {}),
        "content-type": "application/octet-stream",
      },
      body: Buffer.from(encrypted),
      signal: controller.signal,
    });
    if (!putResponse.ok) {
      deps.logger.warn("[blob-client] upload PUT rejected", { status: putResponse.status });
      return null;
    }
    return blobId;
  } catch (error) {
    deps.logger.warn("[blob-client] upload PUT failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Inverse of `uploadBlob`: requests a download URL, GETs the bytes, then
 * decrypts under `blobKey`. Returns `null` on any failure — `decryptBlob`
 * itself never throws; a bad ciphertext returns null rather than an exception.
 */
export async function downloadBlob(
  blobId: string,
  blobKey: Uint8Array,
  deps: BlobClientDeps,
): Promise<Uint8Array | null> {
  const requested = await fetchJson(
    deps,
    "/v1/blobs/request-download",
    { blobId },
    REQUEST_TIMEOUT_MS,
  );
  if (!requested) return null;
  const { downloadUrl, headers } = requested;
  if (typeof downloadUrl !== "string") {
    deps.logger.warn("[blob-client] request-download returned an invalid response");
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const getResponse = await deps.fetchImpl(downloadUrl, {
      method: "GET",
      headers: headers && typeof headers === "object" ? (headers as Record<string, string>) : {},
      signal: controller.signal,
    });
    if (!getResponse.ok) {
      deps.logger.warn("[blob-client] download GET rejected", { status: getResponse.status });
      return null;
    }
    const bytes = new Uint8Array(await getResponse.arrayBuffer());
    return decryptBlob(bytes, blobKey);
  } catch (error) {
    deps.logger.warn("[blob-client] download GET failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
