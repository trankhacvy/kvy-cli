/**
 * Daemon-side core for the `adopt.mirror` machine RPC (design §4.4 "payload
 * size rule" / §8 "Read-only mirror on demand", plan.md §16 "3.3 Session
 * adoption (UC9)"): serves an unmanaged session's transcript on demand,
 * chunked so no single RPC round-trip exceeds the 64 KB control-plane cap,
 * rather than uploading whole histories eagerly (design: "bandwidth +
 * privacy frugality").
 *
 * Chunking cuts on line boundaries, never mid-line: a raw byte-offset cut
 * could split a multi-byte UTF-8 character (or a JSON line) in half,
 * corrupting the decoded chunk. `nextCursor` is always a byte offset that
 * starts a new line — a caller pages through by re-requesting with
 * `cursor: nextCursor` until `done`.
 *
 * `blobRef` (see `AdoptMirrorResultSchema`) is the blob-storage fallback for
 * very large transcripts (plan.md §16 "4.3 Distribution & self-host"): on
 * the *first* page of a mirror (`params.cursor === undefined`) only, when
 * the transcript doesn't fit in one chunk, this handler also encrypts+
 * uploads the whole file via `deps.uploadBlob` (best-effort — never throws,
 * see `blobClient.ts`) and includes the resulting `blobId` alongside that
 * first chunk. The chunked path itself is unconditional and correct on its
 * own (this is still "an efficiency improvement," not a correctness fix) —
 * a caller with `deps.uploadBlob` unwired, or an upload that fails, just
 * keeps paging chunk-by-chunk exactly as before this subsystem existed.
 * Only uploaded once per mirror session (not re-uploaded on every
 * subsequent `cursor` page) since the file doesn't change mid-mirror.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdoptMirrorParams, AdoptMirrorResult } from "@kvy/wire";
import { getProjectPath } from "../claude/scanner.js";
import type { Logger } from "../logger.js";
import type { ProviderSessionResolver } from "./providerSessionResolver.js";

const MAX_CHUNK_BYTES = 64 * 1024;
const DEFAULT_CHUNK_BYTES = 32 * 1024;
const NEWLINE_BYTE = 0x0a;

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface TranscriptMirrorDeps {
  resolveProviderSession: ProviderSessionResolver;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Encrypts+uploads the full transcript and resolves its `blobId`, or `null` on any failure — see `blobClient.ts`'s `uploadBlob`. No default: unset means `blobRef` simply stays unset, same as before this subsystem existed. Only ever called for the first page of a transcript that doesn't fit in one chunk. */
  uploadBlob?: (plaintext: Uint8Array) => Promise<string | null>;
}

/**
 * Picks the end offset for one chunk starting at `start`: the requested
 * byte budget, pulled back to the nearest preceding newline so a chunk
 * never ends mid-line — except for the final chunk (nothing after it to
 * protect) or a single line so long it exceeds the whole budget on its own
 * (falls back to a hard byte cut; a pathologically long single JSONL line
 * is a rare edge case with no better option within the size cap).
 */
export function findChunkEnd(buf: Buffer, start: number, maxBytes: number): number {
  const hardEnd = Math.min(start + maxBytes, buf.length);
  if (hardEnd >= buf.length) return buf.length;
  const newlineIndex = buf.lastIndexOf(NEWLINE_BYTE, hardEnd - 1);
  if (newlineIndex >= start) return newlineIndex + 1; // include the newline itself in this chunk
  return hardEnd;
}

/**
 * Reads one chunk of `params.providerSessionId`'s transcript, starting at
 * `params.cursor` (default 0). Throws if the provider session can't be
 * resolved to a registered workspace, or if the transcript file can't be
 * read — both are real failures the caller should see as an error, not a
 * silently-empty mirror.
 */
export async function handleAdoptMirror(
  params: AdoptMirrorParams,
  deps: TranscriptMirrorDeps,
): Promise<AdoptMirrorResult> {
  const logger = deps.logger ?? noopLogger;
  const resolved = await deps.resolveProviderSession(params.providerSessionId);
  if (!resolved) {
    throw new Error(
      `adopt.mirror: could not resolve provider session "${params.providerSessionId}" to a registered workspace`,
    );
  }

  const projectDir = getProjectPath(resolved.directory, deps.env ?? process.env);
  const file = path.join(projectDir, `${params.providerSessionId}.jsonl`);

  // `providerSessionId` arrives as an unvalidated string over the wire
  // (`AdoptMirrorParamsSchema` only requires `z.string()`) and is
  // interpolated straight into a filesystem path above — without this
  // check, a value like `../../../../tmp/evil` would resolve outside
  // `projectDir` entirely (path traversal, CWE-22) and let a caller read
  // arbitrary `*.jsonl` files reachable from the daemon's working
  // directory. Every legitimate id is a bare filename inside `projectDir`
  // (it comes from a `readdir()` of that directory elsewhere in this
  // codebase — `adopt/listSessions.ts`, `transcriptIndexer.ts`), so the
  // resolved path must stay contained.
  const resolvedFile = path.resolve(file);
  const resolvedProjectDir = path.resolve(projectDir) + path.sep;
  if (!resolvedFile.startsWith(resolvedProjectDir)) {
    throw new Error(`adopt.mirror: invalid provider session id "${params.providerSessionId}"`);
  }

  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch (error) {
    logger.warn("[adopt-mirror] failed to read transcript", {
      file,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `adopt.mirror: failed to read transcript for "${params.providerSessionId}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const cursor = params.cursor ?? 0;
  if (cursor > buf.length) {
    throw new Error(
      `adopt.mirror: cursor ${cursor} is past the end of "${params.providerSessionId}"'s transcript (${buf.length} bytes)`,
    );
  }

  const chunkBytes = Math.min(Math.max(params.maxBytes ?? DEFAULT_CHUNK_BYTES, 1), MAX_CHUNK_BYTES);
  const end = findChunkEnd(buf, cursor, chunkBytes);
  const chunk = buf.subarray(cursor, end).toString("utf8");
  const done = end >= buf.length;

  let blobRef: string | undefined;
  if (params.cursor === undefined && !done && deps.uploadBlob) {
    blobRef = (await deps.uploadBlob(new Uint8Array(buf))) ?? undefined;
  }

  return { chunk, nextCursor: done ? null : end, done, blobRef };
}
