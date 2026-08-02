/**
 * Per-workspace settings — `kvy workspace config [--base-ref <ref>]
 * [--remote <name>] [--setup-script <script>] [--run-script <script>]
 * panel"; docs/features/setup-run-scripts.md "Per-workspace Setup/Run
 * scripts"). Backs both the CLI command (`commands/workspaceConfig.ts`) and
 * the daemon's `git.diff` RPC (`daemon/gitDiff.ts`'s
 * `resolveConfiguredBaseRef` default), which reads the same store to fill
 * in `baseRef` when a caller's RPC params omit one — plus, as of
 * setup-run-scripts, `daemon/setupScript.ts`/`daemon/runProcess.ts` (the
 * setup-on-worktree-creation hook and the `run.*` machine RPCs), which read
 * `setupScript`/`runScript` the exact same way.
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
 * `path.resolve` of the raw input — `kvy workspace config` should still
 * be usable to pre-configure a workspace, and a lookup miss just means
 * `git.diff` falls back to its own no-config default rather than throwing.
 *
 * docs/features/setup-run-scripts.md's central risk note): no machine RPC
 * ever carries a script string as a params field — `workspace.getConfig` is
 * read-only and `run.*`/setup only ever read `setupScript`/`runScript` back
 * off this same on-disk store via a `worktree` path. `setWorkspaceGitConfig`
 * gives every field — including the two new script fields — explicit
 * clear-on-empty-string semantics: a patch field set to `""` deletes that
 * key from the stored config entirely (rather than storing a meaningless
 * empty script), so `kvy workspace config --run-script ""` is how a user
 * un-configures a run script. A field simply omitted from the patch is left
 * untouched, same as today.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { type PersistenceOptions, readSettings, updateSettings } from "./persistence.js";

export interface WorkspaceGitConfig {
  baseRef?: string;
  remote?: string;
  /** Runs once, fire-and-forget, in a freshly-created worktree directory right after `git worktree add` (never on a reused/in-place checkout) — `daemon/setupScript.ts`. E.g. `"npm install"`. */
  setupScript?: string;
  /** A long-lived, remotely start/stop-able process launched via the `run.*` machine RPCs (`daemon/runProcess.ts`) — e.g. `"npm run dev"`. */
  runScript?: string;
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

/** Reads the configured `{baseRef, remote, setupScript, runScript}` for `directory`, or `null` if none is set. Never throws — a missing/corrupt settings.json reads as "no config", same as every other `persistence.ts` reader. */
export async function readWorkspaceGitConfig(
  directory: string,
  options: PersistenceOptions = {},
): Promise<WorkspaceGitConfig | null> {
  const key = await resolveWorkspaceKey(directory);
  const settings = await readSettings(options);
  return settings.workspaces?.[key] ?? null;
}

const WORKSPACE_GIT_CONFIG_FIELDS = ["baseRef", "remote", "setupScript", "runScript"] as const;

/**
 * Merges `patch` into the stored config for `directory` (only the fields
 * present in `patch` are changed) and returns the resulting config.
 * `kvy workspace config` with neither `--base-ref`/`--remote`/
 * `--setup-script`/`--run-script` should just read the current config back —
 * pass an empty `patch` for that rather than special-casing it here.
 *
 * **Clear-on-empty-string:** a patch field set to the empty string `""`
 * DELETES that key from the stored config, rather than storing an empty
 * string — `kvy workspace config --run-script ""` is how a user
 * un-configures a previously-set run script. A field simply absent from
 * `patch` is left untouched.
 */
export async function setWorkspaceGitConfig(
  directory: string,
  patch: WorkspaceGitConfig,
  options: PersistenceOptions = {},
): Promise<WorkspaceGitConfig> {
  const key = await resolveWorkspaceKey(directory);
  const updated = await updateSettings((current) => {
    const existing = current.workspaces?.[key] ?? {};
    const merged: WorkspaceGitConfig = { ...existing };
    for (const field of WORKSPACE_GIT_CONFIG_FIELDS) {
      const value = patch[field];
      if (value === undefined) continue;
      if (value === "") {
        delete merged[field];
      } else {
        merged[field] = value;
      }
    }
    return {
      ...current,
      workspaces: { ...current.workspaces, [key]: merged },
    };
  }, options);
  return updated.workspaces?.[key] ?? {};
}
