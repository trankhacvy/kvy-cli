import type {
  GitBranchInfo,
  GitRemoteInfo,
  WorkspaceGetConfigResult,
  WorkspaceSetConfigResult,
} from "@falcon/wire";

/**
 * View-model types for the Workspace Settings dialog's Git tab. Structural
 * clone of `features/run-panel/types.ts`'s seam layout.
 */
export type WorkspaceGitConfig = WorkspaceGetConfigResult;

/** A patch to `baseRef`/`remote` only — never `setupScript`/`runScript`, see
 * `workspace.setConfig`'s own doc comment in `@falcon/wire`'s `rpc.ts`. */
export interface WorkspaceGitConfigPatch {
  baseRef?: string;
  remote?: string;
}

/**
 * The daemon RPC surface the Workspace Settings dialog needs, seamed off
 * from *how* those calls reach the daemon — mirrors `features/run-panel`'s
 * `RunPanelActions`. Swapped for the real `machineRpcToWorkspaceSettingsActions`
 * (`live-actions.ts`) once the dialog has a live `apiSocket` + a crypto
 * client holding the target machine's unwrapped DEK.
 */
export interface WorkspaceSettingsActions {
  /** Fetches the workspace's configured `baseRef`/`remote` for `worktree`. Throws on failure (e.g. an unregistered worktree). */
  getConfig(worktree: string): Promise<WorkspaceGitConfig>;
  /** Patches `baseRef`/`remote` for `worktree` and writes them to the daemon's local config. Throws on failure. */
  setConfig(worktree: string, patch: WorkspaceGitConfigPatch): Promise<WorkspaceSetConfigResult>;
  /** Lists local branches for `worktree`'s repo — the base-branch picker's source. Throws on failure. */
  listBranches(worktree: string): Promise<GitBranchInfo[]>;
  /** Lists configured git remotes for `worktree`'s repo — the remote-name autofill's source. Throws on failure. */
  listRemotes(worktree: string): Promise<GitRemoteInfo[]>;
}

/** One Workspace Settings actions client per chosen machine — mirrors `UseRunPanelActions`. */
export type UseWorkspaceSettingsActions = (machineId: string) => WorkspaceSettingsActions;
