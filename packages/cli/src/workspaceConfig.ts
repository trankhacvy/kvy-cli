/**
 * Per-workspace git settings — `falcon workspace config [--base-ref
 * <ref>] [--remote <name>] [--directory <path>]` (falcon-prd.md line 148,
 * plan.md §16 "4.1 Git panel"). Backs both the CLI command
 * (`commands/workspaceConfig.ts`) and the daemon's `git.diff` RPC
 * (`daemon/gitDiff.ts`'s `resolveConfiguredBaseRef` default), which reads
 * the same store to fill in `baseRef` when a caller's RPC params omit one.
 *
 * Stored in `settings.json` (`persistence.ts`'s `Settings.workspaces`) —
 * reuses its existing atomic lock-file-guarded read-modify-write rather than
 * introducing a second file with its own locking scheme, same rationale as
 * `adopt/lineage.ts`'s `adoptedSessions` map.
 *
 * Keyed by the workspace directory's real (symlink-resolved) absolute path
 * so a lookup from the daemon side (already-resolved `worktree` paths, e.g.
 * `workspacePath.ts`'s `realDirectory`) and a lookup from the CLI side
 * (`process.cwd()`, possibly through a symlink) land on the same key. A
 * directory that doesn't exist yet (or vanished) falls back to
 * `path.resolve` of the raw input — `falcon workspace config` should still
 * be usable to pre-configure a workspace, and a lookup miss just means
 * `git.diff` falls back to its own no-config default rather than throwing.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { type PersistenceOptions, readSettings, updateSettings } from "./persistence.js";

export interface WorkspaceGitConfig {
  baseRef?: string;
  remote?: string;
}

/** Resolves `directory` to the key `workspaces` is stored under — real path when it exists, else the plain absolute path. */
export async function resolveWorkspaceKey(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/** Reads the configured `{baseRef, remote}` for `directory`, or `null` if none is set. Never throws — a missing/corrupt settings.json reads as "no config", same as every other `persistence.ts` reader. */
export async function readWorkspaceGitConfig(
  directory: string,
  options: PersistenceOptions = {},
): Promise<WorkspaceGitConfig | null> {
  const key = await resolveWorkspaceKey(directory);
  const settings = await readSettings(options);
  return settings.workspaces?.[key] ?? null;
}

/**
 * Merges `patch` into the stored config for `directory` (only the fields
 * present in `patch` are changed) and returns the resulting config.
 * `falcon workspace config` with neither `--base-ref` nor `--remote` should
 * just read the current config back — pass an empty `patch` for that rather
 * than special-casing it here.
 */
export async function setWorkspaceGitConfig(
  directory: string,
  patch: WorkspaceGitConfig,
  options: PersistenceOptions = {},
): Promise<WorkspaceGitConfig> {
  const key = await resolveWorkspaceKey(directory);
  const updated = await updateSettings((current) => {
    const existing = current.workspaces?.[key] ?? {};
    const merged: WorkspaceGitConfig = { ...existing, ...patch };
    return {
      ...current,
      workspaces: { ...current.workspaces, [key]: merged },
    };
  }, options);
  return updated.workspaces?.[key] ?? {};
}
