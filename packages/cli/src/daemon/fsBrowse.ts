/**
 * `fs.list`/`fs.mkdir` machine RPC handlers: directory browsing/creation.
 *
 * Deliberately NOT scoped to a registered workspace root — the user is
 * choosing which directory *becomes* a workspace. This module only lets the
 * caller see and create directories, never launches anything in them.
 */
import { mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { FsEntry, FsListParams, FsListResult, FsMkdirParams, FsMkdirResult } from "@kvy/wire";

export class FsBrowseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsBrowseError";
  }
}

/** Lists the directories inside `params.path` (or the machine's home directory when omitted). Files are excluded — the picker only ever navigates directories. */
export async function listDirectory(params: FsListParams): Promise<FsListResult> {
  const target = params.path ?? homedir();
  if (!path.isAbsolute(target)) {
    throw new FsBrowseError(`path must be absolute: ${target}`);
  }

  let resolved: string;
  try {
    resolved = await realpath(target);
  } catch {
    throw new FsBrowseError(`directory not found: ${target}`);
  }

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await readdir(resolved, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    throw new FsBrowseError(
      `could not list ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const entries: FsEntry[] = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => ({ name: dirent.name, isDirectory: true }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? null : parent,
    entries,
  };
}

/** Creates `params.path` (and any missing parents), recursively. Idempotent — an already-existing directory is a success, not an error. */
export async function createDirectory(params: FsMkdirParams): Promise<FsMkdirResult> {
  if (!path.isAbsolute(params.path)) {
    throw new FsBrowseError(`path must be absolute: ${params.path}`);
  }
  try {
    await mkdir(params.path, { recursive: true });
  } catch (error) {
    throw new FsBrowseError(
      `could not create directory ${params.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { ok: true };
}
