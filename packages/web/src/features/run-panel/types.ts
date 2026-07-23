import type {
  RunSetupResult,
  RunStartResult,
  RunStatusResult,
  RunStopResult,
  WorkspaceGetConfigResult,
} from "@falcon/wire";

/**
 * View-model types for the "Setup / Run" tab (falcon-system-design.md §4.4
 * `workspace.getConfig`/`run.*`; docs/features/setup-run-scripts.md
 * "Per-workspace Setup/Run scripts"). Structural clone of
 * `features/git-diff/types.ts`'s seam layout.
 *
 * `RunConfig`/`RunStatusSnapshot` are re-exported straight off `@falcon/wire`
 * rather than redeclared — the RPC results are already exactly what this
 * panel wants to render, same reasoning as `features/git-diff/types.ts`'s
 * own `GitStatusSnapshot`.
 */
export type RunConfig = WorkspaceGetConfigResult;
export type RunStatusSnapshot = RunStatusResult;

/**
 * The RPC surface the Setup/Run panel needs, seamed off from *how* those
 * calls reach the daemon — mirrors `features/git-diff`'s `GitDiffActions`.
 * Mock by default (`mock-source.ts`), swapped for the real
 * `machineRpcToRunPanelActions(createMachineRpcClient({...}))`
 * (`live-actions.ts`) once a screen has a live `apiSocket` + a crypto client
 * holding the target machine's unwrapped DEK.
 *
 * Script DEFINITION is deliberately absent from this surface — every method
 * here takes only a `worktree` path, never a script string (design §12's
 * local-consent boundary, docs/features/setup-run-scripts.md's central risk
 * note: scripts are defined CLI-only, via `falcon workspace config
 * --setup-script/--run-script`, and never travel over the wire).
 */
export interface RunPanelActions {
  /** Fetches the workspace's configured `baseRef`/`remote`/`setupScript`/`runScript` for `worktree`. Throws on failure (e.g. an unregistered worktree). */
  getConfig(worktree: string): Promise<RunConfig>;
  /** Starts the configured run script for `worktree`. Throws when no `runScript` is configured, or the worktree is unauthorized. */
  start(worktree: string): Promise<RunStartResult>;
  /** Stops `worktree`'s active run process, if any. */
  stop(worktree: string): Promise<RunStopResult>;
  /** Fetches the current run/setup status for `worktree`, including a log tail of each. Throws on failure. */
  status(worktree: string): Promise<RunStatusSnapshot>;
  /** Re-runs the configured setup script for `worktree` ("Re-run setup"). Throws when no `setupScript` is configured, or the worktree is unauthorized. */
  setup(worktree: string): Promise<RunSetupResult>;
}

/** One Setup/Run-panel actions client per chosen machine — mirrors `UseGitDiffActions = (machineId) => GitDiffActions`. */
export type UseRunPanelActions = (machineId: string) => RunPanelActions;
