/**
 * Daemon-side HTTP client for the blob storage subsystem (falcon-system-
 * design.md §6.2 "POST /blobs/request-upload   POST /blobs/request-download",
 * §6.5; plan.md §16 "4.3 Distribution & self-host"). Encrypts with
 * `encryptBlob`/a machine-DEK-derived blob key (`deriveBlobKey`, design
 * §5.1) *before* ever talking to the server — same "server is blind"
 * boundary every other content path in this codebase respects.
 *
 * This is what backs the `blobRef` fields `git.diff`/`adopt.mirror`
 * reserved on the wire (`@falcon/wire`'s `rpc.ts`) for exactly this
 * subsystem, once it existed — see `gitDiff.ts`/`transcriptMirror.ts`'s own
 * doc comments for how they consume `uploadBlob` below.
 *
 * Best-effort by design: every method here resolves `null` (never throws)
 * on any network/HTTP/decode failure, logged at `warn`. A failed blob
 * upload must never crash the RPC handler that was about to fall back to
 * inline/chunked delivery anyway — it just doesn't get the `blobRef`
 * efficiency win this time. Mirrors `unmanagedSessionClient.ts`'s own
 * "best-effort side channel, log and return a falsy sentinel" contract.
 */
import { createHash } from "node:crypto";
import { decryptBlob, encryptBlob } from "@falcon/crypto";
import type { Logger } from "../logger.js";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3005";
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 60_000;

export interface BlobClientDeps {
  serverUrl: string;
  token: string;
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
  required: Pick<BlobClientDeps, "token">,
  overrides: Partial<BlobClientDeps> = {},
): BlobClientDeps {
  return {
    serverUrl: process.env.FALCON_SERVER_URL?.trim() || DEFAULT_SERVER_URL,
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
    const response = await deps.fetchImpl(`${deps.serverUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.token}` },
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
 * Encrypts `plaintext` under `blobKey` and uploads it: `POST
 * /v1/blobs/request-upload` → mint a target, then `PUT` the encrypted bytes
 * to it. Returns the resulting `blobId` (what callers embed as `blobRef`),
 * or `null` on any failure — see this module's header for the never-throw
 * contract.
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
 * Inverse of `uploadBlob`: `POST /v1/blobs/request-download` → `GET` the
 * bytes → `decryptBlob` under `blobKey`. Returns `null` on any failure
 * (network, missing/foreign blob, or a decrypt failure — `decryptBlob`
 * itself never throws, design principle: unwrap never throws).
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
