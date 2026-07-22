/**
 * `fs.read` machine RPC handler (design §4.4: `'fs.read'({worktree, path,
 * range?}) → { inline?, blobRef?, truncated }`; docs/competitive-notes-
 * omnara.md #5 "Full repo file browser" — the "Repo Files" sidebar tab's
 * file-content fetch, once a path is picked from `git.files`'s tree).
 *
 * Scoped to `worktree` the same way `git.status`/`git.diff` are (unlike
 * `fs.list`/`fs.mkdir`, which are deliberately unscoped — see that module's
 * own doc comment): a file *viewer* only ever operates inside an
 * already-known workspace, so `params.path` is always relative to
 * `params.worktree` and is rejected outright if it would escape it (design
 * §12's "no arbitrary-directory execution", the same containment guard
 * `fsBrowse.ts`'s directory picker applies to its own root).
 *
 * **Truncation, plus a best-effort blob upload:** mirrors `gitDiff.ts`
 * exactly — a file that would blow the 64KB RPC control-plane budget
 * (design §4.4 "payload size rule") is truncated inline with `truncated:
 * true`; when `deps.uploadBlob` is wired, the full file is also uploaded
 * and referenced via `blobRef`. `params.range`, when given, is a byte-offset
 * slice `[start, end)` of the file — used to page through a large file
 * instead of always re-serving the same truncated prefix (same byte-cursor
 * idea as `adopt.mirror`'s transcript paging), still clamped to
 * `maxInlineBytes` so an oversized explicit range can't itself blow the
 * budget.
 */
import {
  readFile as readFileNode,
  realpath as realpathNode,
  stat as statNode,
} from "node:fs/promises";
import path from "node:path";
import type { FsReadParams, FsReadResult } from "@falcon/wire";

export class FsReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsReadError";
  }
}

/** Stays well under the 64KB RPC control-plane cap (design §4.4) after JSON envelope + encryption overhead — same budget as `gitDiff.ts`'s own `MAX_INLINE_BYTES`. */
const MAX_INLINE_BYTES = 60_000;

export interface FsReadDeps {
  maxInlineBytes?: number;
  /** Encrypts+uploads the full file and resolves its `blobId`, or `null` on any failure — see `gitDiff.ts`'s identically-shaped `uploadBlob`. No default: unset means `blobRef` simply stays unset. Only ever called when the file was actually truncated. */
  uploadBlob?: (plaintext: Uint8Array) => Promise<string | null>;
}

/** A NUL byte anywhere in the sampled prefix is the simplest, cheapest reliable "this isn't text" sniff (the same signal git itself uses to decide whether a path is binary) — good enough for "should this render as a text preview at all", not a full MIME sniff. */
function looksBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Joins `worktree` + `relativePath`, resolving symlinks on both sides, and
 * throws `FsReadError` if `relativePath` is itself absolute or the joined
 * result would escape `worktree` — either via a `../` traversal in the
 * request, or via a symlink *inside* the worktree that points somewhere
 * outside it (checked by re-validating containment after the target's own
 * `realpath`, not just the joined-but-unresolved path).
 */
async function resolveSafePath(worktree: string, relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new FsReadError(`path must be relative to the worktree: ${relativePath}`);
  }

  let resolvedWorktree: string;
  try {
    resolvedWorktree = await realpathNode(worktree);
  } catch {
    throw new FsReadError(`worktree not found: ${worktree}`);
  }

  const joined = path.resolve(resolvedWorktree, relativePath);
  const relativeToWorktree = path.relative(resolvedWorktree, joined);
  if (relativeToWorktree.startsWith("..") || path.isAbsolute(relativeToWorktree)) {
    throw new FsReadError(`path escapes the worktree: ${relativePath}`);
  }

  let resolved: string;
  try {
    resolved = await realpathNode(joined);
  } catch {
    throw new FsReadError(`file not found: ${relativePath}`);
  }

  const relativeResolved = path.relative(resolvedWorktree, resolved);
  if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
    throw new FsReadError(`path escapes the worktree: ${relativePath}`);
  }

  return resolved;
}

/** Reads `params.path` (relative to `params.worktree`) and returns its content as an inline (possibly truncated) UTF-8 string. Throws `FsReadError` for a missing/escaping/binary/directory target — no silent empty-content fallback. */
export async function readFile(params: FsReadParams, deps: FsReadDeps = {}): Promise<FsReadResult> {
  const maxInlineBytes = deps.maxInlineBytes ?? MAX_INLINE_BYTES;
  const resolved = await resolveSafePath(params.worktree, params.path);

  let stats: Awaited<ReturnType<typeof statNode>>;
  try {
    stats = await statNode(resolved);
  } catch (error) {
    throw new FsReadError(
      `could not stat ${params.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stats.isDirectory()) {
    throw new FsReadError(`${params.path} is a directory, not a file`);
  }

  let buffer: Buffer;
  try {
    buffer = await readFileNode(resolved);
  } catch (error) {
    throw new FsReadError(
      `could not read ${params.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (looksBinary(buffer)) {
    throw new FsReadError(`${params.path} looks like a binary file — no text preview available`);
  }

  if (params.range) {
    const start = Math.max(0, params.range.start);
    const requestedEnd = Math.min(buffer.length, params.range.end);
    const cappedEnd = Math.min(requestedEnd, start + maxInlineBytes);
    const slice = buffer.subarray(start, Math.max(start, cappedEnd));
    const truncated = start > 0 || cappedEnd < buffer.length;
    return { inline: slice.toString("utf8"), truncated };
  }

  if (buffer.length <= maxInlineBytes) {
    return { inline: buffer.toString("utf8"), truncated: false };
  }

  const slice = buffer.subarray(0, maxInlineBytes);
  const text = `${slice.toString("utf8")}\n\n… (file truncated at ${maxInlineBytes} bytes)\n`;

  let blobRef: string | undefined;
  if (deps.uploadBlob) {
    blobRef = (await deps.uploadBlob(new Uint8Array(buffer))) ?? undefined;
  }

  return { inline: text, truncated: true, blobRef };
}
