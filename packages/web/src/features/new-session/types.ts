import type { PermissionMode, ProviderId, WorkspaceGetConfigResult } from "@kvy/wire";

/**
 * Shared RPC/view-model types for spawning a session against a machine
 * (kvy-system-design.md §9.2 "New session" row, kvy-prd.md
 * FR-7.5/UC5). Originally the old free-form wizard's types (machine picker →
 * directory picker → provider/mode/model → spawn); the machine/directory
 * concepts (`NewSessionMachine`, `DirectoryListing`'s browse-centric
 * companions) were retired in the B5 redesign — the workspace-row `+` flow
 * always already knows its machine and directory (B1's `target-machine.ts`,
 * a workspace's own registered id) — but `NewSessionActions`/`SpawnRequest`/
 * `BranchOption`/`BranchItem`/`ImportCandidate` remain the shared contract
 * `features/session-list`'s inline creation panel spawns through.
 *
 * `DirectoryListing` is a decrypted/plaintext-routing view-model the same
 * way `features/session-list/types.ts`'s `SessionListMachine` is — the
 * underlying `MachineRow.metadata` is an `EncryptedBox`, decrypted upstream.
 */

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

/** Mirrors `@kvy/wire`'s `FsListResult` — the daemon `fs.list` RPC's response, one directory's worth of browsing. */
export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
}

export type NewSessionProvider = ProviderId;

export interface BranchOption {
  name: string;
  createWorktree: boolean;
  /**
   * The base ref a brand-new branch is created from (docs/competitive-notes-omnara.md
   * #16 "searchable base-branch picker") — e.g. `main`/`master` instead of
   * always forking off whatever's currently checked out. Only meaningful
   * when this branch doesn't exist yet; `undefined` preserves the old
   * "branch from current HEAD" behavior.
   */
  from?: string;
}

/**
 * One local branch the daemon's `git.branches` machine RPC surfaced —
 * mirrors `@kvy/wire`'s `GitBranchInfo` (docs/features/worktree-isolation.md
 * Phase 4). Backs the existing-branch worktree picker in `OptionsStep`.
 */
export interface BranchItem {
  name: string;
  isCurrent: boolean;
  /** Absolute path of the worktree this branch is already checked out in, if any — git forbids the same branch in two worktrees, so a row with this set should render disabled. */
  checkedOutAt?: string;
  upstream?: string;
  lastCommitAt?: number;
}

export interface SpawnRequest {
  directory: string;
  provider: NewSessionProvider;
  permissionMode: PermissionMode;
  model?: string;
  /** P1 — kvy-prd.md FR-1.2 "`kvy -b <branch>`". */
  branch?: BranchOption;
  /** Set when the session-import step (kvy-prd.md FR-7.8 UC7 "continue
   * from a recent CLI session") picked a candidate to continue instead of
   * starting fresh — mirrors `@kvy/wire`'s `SpawnParams.continueFrom`. */
  continueFrom?: { providerSessionId: string };
}

/**
 * One recent plain (non-Kvy) CLI session the daemon's `adopt.list`
 * machine RPC surfaced for a chosen directory — the session-import step's
 * view-model, mirroring `@kvy/wire`'s `ProviderSessionSummary` (design
 * §4.4, kvy-prd.md FR-7.8/FR-9.1-9.2 UC7/UC9). Same "decrypted upstream"
 * convention as the rest of this file's view-models — there's nothing to
 * decrypt here (the daemon computes this straight from local transcript
 * files), but the shape stays a plain view-model for consistency with
 * `DirectoryListing`/`NewSessionMachine`.
 */
export interface ImportCandidate {
  providerSessionId: string;
  /** Best-effort title derived from the transcript's first user message; absent when the daemon couldn't determine one. */
  title?: string;
  lastActivityAt: number;
  /** Best-effort liveness from the daemon's process scan — absent means "unknown", not "not running" (design §8). */
  running?: boolean;
}

/**
 * Mirrors `@kvy/wire`'s `SpawnResult`, flattened into a discriminated
 * union — easier for the screen to branch on than the wire's "exactly one
 * of two optional fields" shape. `action` carries `SpawnResult.
 * requiresApproval.action` through untouched (plan.md §16 "Flow 3 —
 * spawn-fresh-folder-register (Piece A)"): `"create-directory"` (the
 * existing loop — the target directory doesn't exist yet) or
 * `"register-workspace"` (a genuinely fresh, never-registered folder —
 * `spawn-flow.ts`'s `runSpawnFlow` branches on this to call
 * `createDirectory`/`registerWorkspace` respectively before retrying).
 */
export type SpawnOutcome =
  | { type: "success"; sessionId: string }
  | {
      type: "requiresApproval";
      action: "create-directory" | "register-workspace";
      directory: string;
    };

/**
 * The RPC surface this flow needs, seamed off from *how* those calls reach
 * the daemon (mirrors `features/session-control`'s `SessionControlActions`
 * pattern) — mock by default (`mock-source.ts`), swapped for
 * `machineRpcToActions(createMachineRpcClient({...}))` (`live-actions.ts`)
 * once a screen has a live `apiSocket` + a crypto client holding the chosen
 * machine's unwrapped DEK.
 */
export interface NewSessionActions {
  /** Lists directories at `path` (server's machine's home directory when omitted). Throws on failure (unreachable machine, permission error, ...). */
  browseDirectory(path?: string): Promise<DirectoryListing>;
  /** Creates `path` (and any missing parents) on the machine. Throws on failure. */
  createDirectory(path: string): Promise<void>;
  /** Registers `directory` as a genuine Kvy workspace (the daemon's `workspace.register` RPC, plan.md §16 "Flow 3 — spawn-fresh-folder-register (Piece A)") — backs the `register-workspace` approval branch of `spawn`, the same way `createDirectory` backs `create-directory`. Idempotent; throws only on a real failure. */
  registerWorkspace(directory: string): Promise<void>;
  spawn(request: SpawnRequest): Promise<SpawnOutcome>;
  /** Lists recent plain `claude`/`codex` sessions for `directory` (the daemon's `adopt.list` RPC, keyed by workspace — `directory` doubles as the workspace id, same convention `spawn`'s `workspaceId` already uses in `live-actions.ts`) — the session-import step's data source (kvy-prd.md FR-7.8 UC7). Throws on failure (unreachable machine, ...); an empty array means "none found", not an error. */
  listImportCandidates(directory: string): Promise<ImportCandidate[]>;
  /** Lists local branches at `directory` (the daemon's `git.branches` RPC, docs/features/worktree-isolation.md — `directory` doubles as the RPC's `worktree` param, same "a workspaceId/worktree IS a directory path" convention as `spawn`/`listImportCandidates` above) — the existing-branch worktree picker's data source. Throws on failure (unreachable machine, not a git repo, ...); an empty array means "no local branches", not an error. */
  listBranches(directory: string): Promise<BranchItem[]>;
  /** Reads `directory`'s per-workspace config (the daemon's `workspace.getConfig` RPC) — used here only for `baseRef`, the base-branch picker's preferred default (`inline-spawn.ts`'s `deriveDefaultBaseBranch`). Throws on failure (unreachable machine, ...); an object with every field `undefined` means "nothing configured yet", not an error. */
  getConfig(directory: string): Promise<WorkspaceGetConfigResult>;
}

/** One machine RPC actions client per chosen machine — mirrors `UseSessionControl = (sessionId) => SessionControlActions`. */
export type UseNewSessionActions = (machineId: string) => NewSessionActions;
