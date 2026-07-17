/**
 * `falcon workspace config [--base-ref <ref>] [--remote <name>]
 * [--directory <path>]` (falcon-prd.md line 148: "Per-workspace settings
 * (base ref for diffs, git remote)"; plan.md §16 "4.1 Git panel"). Sets (or,
 * with no `--base-ref`/`--remote`, just prints) the configured git base ref
 * and remote for a workspace directory — `--directory` defaults to the
 * current working directory.
 *
 * This is the terminal-side counterpart to `daemon/gitDiff.ts`'s
 * `resolveConfiguredBaseRef`: both read/write the same
 * `workspaceConfig.ts` store, keyed by the workspace's real (symlink-
 * resolved) directory path, so a `git.diff` RPC call that omits an explicit
 * `baseRef` picks up whatever was set here.
 */
import type { PersistenceOptions } from "../persistence.js";
import { readWorkspaceGitConfig, setWorkspaceGitConfig } from "../workspaceConfig.js";

export interface WorkspaceConfigCommandOptions {
  baseRef?: string;
  remote?: string;
  directory?: string;
}

export interface WorkspaceConfigCommandDeps {
  workingDirectory: string;
  persistenceOptions?: PersistenceOptions;
  write?: (text: string) => void;
}

function formatConfig(directory: string, config: { baseRef?: string; remote?: string }): string {
  const baseRef = config.baseRef ?? "(none)";
  const remote = config.remote ?? "(none)";
  return `falcon workspace config: ${directory}\n  base ref: ${baseRef}\n  remote:   ${remote}\n`;
}

/** Runs `falcon workspace config`. Returns the process exit code — always 0; a bad `--directory` just means the config lookup/write keys on the raw path (see `workspaceConfig.ts`'s `resolveWorkspaceKey`), it never fails the command. */
export async function runWorkspaceConfigCommand(
  options: WorkspaceConfigCommandOptions,
  deps: WorkspaceConfigCommandDeps,
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const directory = options.directory ?? deps.workingDirectory;

  const hasPatch = options.baseRef !== undefined || options.remote !== undefined;
  const patch: { baseRef?: string; remote?: string } = {};
  if (options.baseRef !== undefined) patch.baseRef = options.baseRef;
  if (options.remote !== undefined) patch.remote = options.remote;

  const config = hasPatch
    ? await setWorkspaceGitConfig(directory, patch, deps.persistenceOptions)
    : ((await readWorkspaceGitConfig(directory, deps.persistenceOptions)) ?? {});

  write(formatConfig(directory, config));
  return 0;
}
