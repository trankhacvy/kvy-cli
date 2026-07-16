import type { PermissionMode } from "@falcon/wire";

/**
 * View-model types for the New Session flow (falcon-system-design.md §9.2
 * "New session" row, falcon-prd.md FR-7.5/UC5): machine → directory picker
 * → provider/mode/model → (optional branch/worktree) → spawn.
 *
 * `NewSessionMachine`/`DirectoryListing` are decrypted/plaintext-routing
 * view-models the same way `features/session-list/types.ts`'s
 * `SessionListMachine` is — the underlying `MachineRow.metadata` is an
 * `EncryptedBox`, decrypted upstream of this screen.
 */

export interface NewSessionMachine {
  id: string;
  /** Decrypted machine name (e.g. hostname). */
  name: string;
  online: boolean;
}

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

/** Mirrors `@falcon/wire`'s `FsListResult` — the daemon `fs.list` RPC's response, one directory's worth of browsing. */
export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
}

export type NewSessionProvider = "claude-code" | "codex";

export interface BranchOption {
  name: string;
  createWorktree: boolean;
}

export interface SpawnRequest {
  directory: string;
  provider: NewSessionProvider;
  permissionMode: PermissionMode;
  model?: string;
  /** P1 — falcon-prd.md FR-1.2 "`falcon -b <branch>`". */
  branch?: BranchOption;
}

/** Mirrors `@falcon/wire`'s `SpawnResult`, flattened into a discriminated union — easier for the screen to branch on than the wire's "exactly one of two optional fields" shape. */
export type SpawnOutcome =
  | { type: "success"; sessionId: string }
  | { type: "requiresApproval"; directory: string };

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
  spawn(request: SpawnRequest): Promise<SpawnOutcome>;
}

/** One machine RPC actions client per chosen machine — mirrors `UseSessionControl = (sessionId) => SessionControlActions`. */
export type UseNewSessionActions = (machineId: string) => NewSessionActions;

/** Injectable data source for the machine-picker step — mirrors `features/session-list`'s `UseSessionListSnapshot` seam. */
export type UseNewSessionMachines = () => NewSessionMachine[];
