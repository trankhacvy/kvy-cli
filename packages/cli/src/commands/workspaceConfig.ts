/**
 * `kvy workspace config [--base-ref <ref>] [--remote <name>]
 * [--setup-script <script>] [--run-script <script>] [--directory <path>]`
 * (kvy-prd.md line 148: "Per-workspace settings (base ref for diffs, git
 * remote)"; plan.md §16 "4.1 Git panel"; docs/features/
 * setup-run-scripts.md "Per-workspace Setup/Run scripts"). Sets (or, with no
 * flags at all, just prints) the configured git base ref/remote and
 * setup/run scripts for a workspace directory — `--directory` defaults to
 * the current working directory. Passing `--setup-script ""` (or
 * `--run-script ""`) clears that field (see `workspaceConfig.ts`'s
 * `setWorkspaceGitConfig` doc comment for the clear-on-empty-string
 * contract).
 *
 * This is the terminal-side counterpart to `daemon/gitDiff.ts`'s
 * `resolveConfiguredBaseRef` and, as of setup-run-scripts,
 * `daemon/setupScript.ts`/`daemon/runProcess.ts`: all read/write the same
 * `workspaceConfig.ts` store, keyed by the workspace's real (symlink-
 * resolved) directory path, so a `git.diff` RPC call that omits an explicit
 * `baseRef` — or a fresh worktree creation, or a `run.start` RPC — picks up
 * whatever was set here. Script DEFINITION stays CLI-only by design
 * (design §12's local-consent boundary) — no machine RPC ever carries a
 * script string as a params field.
 */
import type { PersistenceOptions } from "../persistence.js";
import {
  readWorkspaceGitConfig,
  setWorkspaceGitConfig,
  type WorkspaceGitConfig,
} from "../workspaceConfig.js";

export interface WorkspaceConfigCommandOptions {
  baseRef?: string;
  remote?: string;
  setupScript?: string;
  runScript?: string;
  directory?: string;
}

export interface WorkspaceConfigCommandDeps {
  workingDirectory: string;
  persistenceOptions?: PersistenceOptions;
  write?: (text: string) => void;
}

function formatConfig(directory: string, config: WorkspaceGitConfig): string {
  const baseRef = config.baseRef ?? "(none)";
  const remote = config.remote ?? "(none)";
  const setupScript = config.setupScript ?? "(none)";
  const runScript = config.runScript ?? "(none)";
  return (
    `kvy workspace config: ${directory}\n` +
    `  base ref:     ${baseRef}\n` +
    `  remote:       ${remote}\n` +
    `  setup script: ${setupScript}\n` +
    `  run script:   ${runScript}\n`
  );
}

/** Runs `kvy workspace config`. Returns the process exit code — always 0; a bad `--directory` just means the config lookup/write keys on the raw path (see `workspaceConfig.ts`'s `resolveWorkspaceKey`), it never fails the command. */
export async function runWorkspaceConfigCommand(
  options: WorkspaceConfigCommandOptions,
  deps: WorkspaceConfigCommandDeps,
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const directory = options.directory ?? deps.workingDirectory;

  const hasPatch =
    options.baseRef !== undefined ||
    options.remote !== undefined ||
    options.setupScript !== undefined ||
    options.runScript !== undefined;
  const patch: WorkspaceGitConfig = {};
  if (options.baseRef !== undefined) patch.baseRef = options.baseRef;
  if (options.remote !== undefined) patch.remote = options.remote;
  if (options.setupScript !== undefined) patch.setupScript = options.setupScript;
  if (options.runScript !== undefined) patch.runScript = options.runScript;

  const config = hasPatch
    ? await setWorkspaceGitConfig(directory, patch, deps.persistenceOptions)
    : ((await readWorkspaceGitConfig(directory, deps.persistenceOptions)) ?? {});

  write(formatConfig(directory, config));
  return 0;
}
