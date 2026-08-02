/**
 * Encrypted attachment upload/download for the composer's attach-file path.
 * Ties together the crypto worker (`sealBlob`/`openBlob`), `api.ts`'s
 * `requestBlobUpload`/`requestBlobDownload`, and a raw `fetch` against
 * whatever presigned URL the server returns.
 */
import type { CryptoBridgeClient } from "@/crypto";
import { requestBlobDownload, requestBlobUpload } from "./api.js";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Encrypts `plaintext` under the active session's blob key and uploads it,
 * returning the resulting `blobId` — what a `file` `SessionEvent`'s `ref`
 * field carries (`@kvy/wire`'s `SessionEventSchema`). Throws on any
 * failure (network, rejected upload) — unlike the daemon's own best-effort
 * `blobClient.ts`, a composer attachment the user explicitly chose to send
 * has no silent-fallback path to degrade to, so the caller surfaces the
 * error instead of pretending the attachment went through.
 */
export async function uploadAttachment(
  token: string,
  bridge: CryptoBridgeClient,
  plaintext: Uint8Array,
  opts: { sessionId?: string } = {},
): Promise<string> {
  const encrypted = await bridge.sealBlob(plaintext);
  const contentHash = await sha256Hex(encrypted);
  const target = await requestBlobUpload(token, {
    size: encrypted.length,
    contentHash,
    sessionId: opts.sessionId,
  });

  const response = await fetch(target.uploadUrl, {
    method: target.method,
    headers: { ...target.headers, "content-type": "application/octet-stream" },
    body: encrypted.slice().buffer as ArrayBuffer,
  });
  if (!response.ok) {
    throw new Error(`attachment upload failed (${response.status})`);
  }

  return target.blobId;
}

/**
 * Inverse of `uploadAttachment`: fetches `blobId`'s encrypted bytes and
 * decrypts them under the active session's blob key. Resolves `null` when
 * the download can't be decrypted (foreign/corrupted blob — `openBlob`
 * never throws), but throws on a network/HTTP failure — same "surface real
 * errors, don't invent a silent empty state" posture as `uploadAttachment`.
 */
export async function downloadAttachment(
  token: string,
  bridge: CryptoBridgeClient,
  blobId: string,
): Promise<Uint8Array | null> {
  const target = await requestBlobDownload(token, blobId);
  const response = await fetch(target.downloadUrl, {
    method: target.method,
    headers: target.headers,
  });
  if (!response.ok) {
    throw new Error(`attachment download failed (${response.status})`);
  }
  const encrypted = new Uint8Array(await response.arrayBuffer());
  return bridge.openBlob(encrypted);
}
