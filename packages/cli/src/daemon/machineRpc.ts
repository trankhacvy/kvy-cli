/**
 * Machine-scoped RPC dispatch for the daemon.
 *
 * Key invariants:
 * - `spawn`/`adopt.take`/`adopt.mirror`/`git.commit`/`git.push`/`git.renameBranch`
 *   cache in-flight `Promise`s (not settled values), keyed on `idempotencyKey`,
 *   so concurrent retries collapse into a single attempt. Failed attempts are
 *   evicted from the cache — never replayed.
 * - `adopt.take` additionally has a resource-keyed guard (`withProviderSessionGuard`)
 *   so two devices adopting the same `providerSessionId` with different keys
 *   join the same in-flight takeover rather than racing.
 * - Read-only RPCs (`fs.list`, `git.status`, `git.diff`, etc.) need no cache:
 *   a retry is just another read.
 */
import { open, seal } from "@kvy/crypto";
import {
  type AdoptMirrorParams,
  AdoptMirrorParamsSchema,
  type AdoptMirrorResult,
  AdoptMirrorResultSchema,
  type AdoptTakeParams,
  AdoptTakeParamsSchema,
  type AdoptTakeResult,
  AdoptTakeResultSchema,
  type EncryptedBox,
  EncryptedBoxSchema,
  type FsListParams,
  FsListParamsSchema,
  type FsListResult,
  FsListResultSchema,
  type FsMkdirParams,
  FsMkdirParamsSchema,
  type FsMkdirResult,
  FsMkdirResultSchema,
  type FsReadParams,
  FsReadParamsSchema,
  type FsReadResult,
  FsReadResultSchema,
  type GitBranchesParams,
  GitBranchesParamsSchema,
  type GitBranchesResult,
  GitBranchesResultSchema,
  type GitCommitParams,
  GitCommitParamsSchema,
  type GitCommitResult,
  GitCommitResultSchema,
  type GitDiffParams,
  GitDiffParamsSchema,
  type GitDiffResult,
  GitDiffResultSchema,
  type GitFilesParams,
  GitFilesParamsSchema,
  type GitFilesResult,
  GitFilesResultSchema,
  type GithubChecksParams,
  GithubChecksParamsSchema,
  type GithubChecksResult,
  GithubChecksResultSchema,
  type GitInitParams,
  GitInitParamsSchema,
  type GitInitResult,
  GitInitResultSchema,
  type GitPushParams,
  GitPushParamsSchema,
  type GitPushResult,
  GitPushResultSchema,
  type GitRemotesParams,
  GitRemotesParamsSchema,
  type GitRemotesResult,
  GitRemotesResultSchema,
  type GitRenameBranchParams,
  GitRenameBranchParamsSchema,
  type GitRenameBranchResult,
  GitRenameBranchResultSchema,
  type GitSetRemoteParams,
  GitSetRemoteParamsSchema,
  type GitSetRemoteResult,
  GitSetRemoteResultSchema,
  type GitStatusParams,
  GitStatusParamsSchema,
  type GitStatusResult,
  GitStatusResultSchema,
  type PreviewCloseParams,
  PreviewCloseParamsSchema,
  type PreviewCloseResult,
  PreviewCloseResultSchema,
  type PreviewOpenParams,
  PreviewOpenParamsSchema,
  type PreviewOpenResult,
  PreviewOpenResultSchema,
  type PreviewPortsParams,
  PreviewPortsParamsSchema,
  type PreviewPortsResult,
  PreviewPortsResultSchema,
  type PreviewTunnelsParams,
  PreviewTunnelsParamsSchema,
  type PreviewTunnelsResult,
  PreviewTunnelsResultSchema,
  type ProviderAccountParams,
  ProviderAccountParamsSchema,
  type ProviderAccountResult,
  ProviderAccountResultSchema,
  ResumeSessionParamsSchema,
  ResumeSessionResultSchema,
  type RunSetupParams,
  RunSetupParamsSchema,
  type RunSetupResult,
  RunSetupResultSchema,
  type RunStartParams,
  RunStartParamsSchema,
  type RunStartResult,
  RunStartResultSchema,
  type RunStatusParams,
  RunStatusParamsSchema,
  type RunStatusResult,
  RunStatusResultSchema,
  type RunStopParams,
  RunStopParamsSchema,
  type RunStopResult,
  RunStopResultSchema,
  type SlashCommandsListParams,
  SlashCommandsListParamsSchema,
  type SlashCommandsListResult,
  SlashCommandsListResultSchema,
  type SleepInhibitGetParams,
  SleepInhibitGetParamsSchema,
  type SleepInhibitSetParams,
  SleepInhibitSetParamsSchema,
  type SleepInhibitState,
  SleepInhibitStateSchema,
  type SpawnParams,
  SpawnParamsSchema,
  type SpawnResult,
  SpawnResultSchema,
  type WorkspaceGetConfigParams,
  WorkspaceGetConfigParamsSchema,
  type WorkspaceGetConfigResult,
  WorkspaceGetConfigResultSchema,
  type WorkspaceRegisterParams,
  WorkspaceRegisterParamsSchema,
  type WorkspaceRegisterResult,
  WorkspaceRegisterResultSchema,
  type WorkspaceSetConfigParams,
  WorkspaceSetConfigParamsSchema,
  type WorkspaceSetConfigResult,
  WorkspaceSetConfigResultSchema,
  type WorkspaceUnregisterParams,
  WorkspaceUnregisterParamsSchema,
  type WorkspaceUnregisterResult,
  WorkspaceUnregisterResultSchema,
  type WorktreeRemoveParams,
  WorktreeRemoveParamsSchema,
  type WorktreeRemoveResult,
  WorktreeRemoveResultSchema,
} from "@kvy/wire";
import type { Socket } from "socket.io-client";
import type { ZodType } from "zod";
import type { Logger } from "../logger.js";
import {
  createDirectory as createDirectoryDefault,
  listDirectory as listDirectoryDefault,
} from "./fsBrowse.js";
import { readFile as readFileDefault } from "./fsRead.js";
import { getGitBranches as getGitBranchesDefault } from "./gitBranches.js";
import { handleGitCommit as handleGitCommitDefault } from "./gitCommit.js";
import { getGitDiff as getGitDiffDefault } from "./gitDiff.js";
import { getGitFiles as getGitFilesDefault } from "./gitFiles.js";
import { getGithubChecks as getGithubChecksDefault } from "./githubChecks.js";
import { handleGitInit as handleGitInitDefault } from "./gitInit.js";
import { handleGitPush as handleGitPushDefault } from "./gitPush.js";
import { getGitRemotes as getGitRemotesDefault } from "./gitRemotes.js";
import { handleGitRenameBranch as handleGitRenameBranchDefault } from "./gitRenameBranch.js";
import { handleGitSetRemote as handleGitSetRemoteDefault } from "./gitSetRemote.js";
import { getGitStatus as getGitStatusDefault } from "./gitStatus.js";
import { getProviderAccountInfo as getProviderAccountInfoDefault } from "./providerAccountInfo.js";
import {
  handleRunSetup as handleRunSetupDefault,
  handleRunStart as handleRunStartDefault,
  handleRunStatus as handleRunStatusDefault,
  handleRunStop as handleRunStopDefault,
} from "./runProcess.js";
import { listSlashCommands as listSlashCommandsDefault } from "./slashCommands.js";
import {
  handleWorkspaceGetConfig as handleWorkspaceGetConfigDefault,
  handleWorkspaceSetConfig as handleWorkspaceSetConfigDefault,
} from "./workspaceConfigRpc.js";
import { WorkspaceValidationError } from "./workspacePath.js";
import {
  registerWorkspace as registerWorkspaceDefault,
  unregisterWorkspace as unregisterWorkspaceDefault,
} from "./workspaceRegisterRpc.js";
import { removeWorktree as removeWorktreeDefault } from "./worktreeRemove.js";

export const MACHINE_RPC_METHODS = [
  "spawn",
  "resumeSession",
  "fs.list",
  "fs.mkdir",
  "workspace.register",
  "workspace.unregister",
  "git.status",
  "git.diff",
  "git.branches",
  "git.remotes",
  "git.commit",
  "git.push",
  "git.renameBranch",
  "git.init",
  "git.setRemote",
  "github.checks",
  "commands.list",
  "git.files",
  "fs.read",
  "provider.account",
  "sleepInhibit.get",
  "sleepInhibit.set",
  "adopt.take",
  "adopt.mirror",
  "preview.ports",
  "preview.tunnels",
  "preview.open",
  "preview.close",
  "workspace.getConfig",
  "workspace.setConfig",
  "run.start",
  "run.stop",
  "run.status",
  "run.setup",
  "worktree.remove",
] as const;
export type MachineRpcMethod = (typeof MACHINE_RPC_METHODS)[number];

export interface MachineRpcDeps {
  machineId: string;
  /** The machine's data-encryption key — RPC params/results are sealed under it, same convention as `rpc/sessionRpc.ts`'s session DEK. */
  dek: Uint8Array;
  socket: Socket;
  /** Performs the actual spawn (`spawnEngine.ts`'s `spawnSession`, typically) — throws (any `Error`) on failure. */
  spawnSession: (params: SpawnParams) => Promise<SpawnResult>;
  /** Performs the actual resume (`resumeSession.ts`'s `resumeSession`, typically) — throws (any `Error`) on failure; the wire result is always a bare `{ok:true}`, so only success/failure matters here. */
  resumeSession: (sessionId: string) => Promise<unknown>;
  /** Backs the `fs.list` directory-picker RPC. Injectable for tests; defaults to `fsBrowse.ts`'s real filesystem listing. Throws on failure. */
  listDirectory?: (params: FsListParams) => Promise<FsListResult>;
  /** Backs the `fs.mkdir` create-directory-approval RPC. Injectable for tests; defaults to `fsBrowse.ts`'s real `mkdir -p`. Throws on failure. */
  createDirectory?: (params: FsMkdirParams) => Promise<FsMkdirResult>;
  /** Backs the `workspace.register` RPC. Injectable for tests; defaults to `workspaceRegisterRpc.ts`. Throws on failure. */
  registerWorkspace?: (params: WorkspaceRegisterParams) => Promise<WorkspaceRegisterResult>;
  /** Backs the `workspace.unregister` RPC. Injectable for tests; defaults to `workspaceRegisterRpc.ts`. Throws on failure. */
  unregisterWorkspace?: (params: WorkspaceUnregisterParams) => Promise<WorkspaceUnregisterResult>;
  /** Backs the `git.status` RPC. Injectable for tests; defaults to `gitStatus.ts`. Throws on failure. */
  getGitStatus?: (params: GitStatusParams) => Promise<GitStatusResult>;
  /** Backs the `git.diff` RPC. Injectable for tests; defaults to `gitDiff.ts`. Throws on failure. */
  getGitDiff?: (params: GitDiffParams) => Promise<GitDiffResult>;
  /** Backs the `git.branches` RPC. Injectable for tests; defaults to `gitBranches.ts`. Throws on failure. */
  getGitBranches?: (params: GitBranchesParams) => Promise<GitBranchesResult>;
  /** Backs the `git.remotes` RPC. Injectable for tests; defaults to `gitRemotes.ts`. Throws on failure. */
  getGitRemotes?: (params: GitRemotesParams) => Promise<GitRemotesResult>;
  /** Backs the `git.commit` RPC. Injectable for tests; defaults to `gitCommit.ts`, gated on the registered-workspace authorizer. Throws on failure. */
  gitCommit?: (params: GitCommitParams) => Promise<GitCommitResult>;
  /** Backs the `git.push` RPC. Injectable for tests; defaults to `gitPush.ts` (`force` maps to `--force-with-lease`), gated on the registered-workspace authorizer. Throws on failure. */
  gitPush?: (params: GitPushParams) => Promise<GitPushResult>;
  /** Backs the `git.renameBranch` RPC. Injectable for tests; defaults to `gitRenameBranch.ts`, gated on the registered-workspace authorizer. Throws on failure. */
  gitRenameBranch?: (params: GitRenameBranchParams) => Promise<GitRenameBranchResult>;
  /** Backs the `git.init` RPC. Injectable for tests; defaults to `gitInit.ts`. Throws on failure; an already-initialized/nested directory resolves as a result `state`, not a throw. */
  gitInit?: (params: GitInitParams) => Promise<GitInitResult>;
  /** Backs the `git.setRemote` RPC. Injectable for tests; defaults to `gitSetRemote.ts`. Throws on failure. */
  gitSetRemote?: (params: GitSetRemoteParams) => Promise<GitSetRemoteResult>;
  /** Backs the `github.checks` RPC. Injectable for tests; defaults to `githubChecks.ts`. A handled "nothing to show yet" case is a result `state`, not a throw. */
  getGithubChecks?: (params: GithubChecksParams) => Promise<GithubChecksResult>;
  /** Backs the `commands.list` RPC. Injectable for tests; defaults to `slashCommands.ts`. Never throws. */
  listSlashCommands?: (params: SlashCommandsListParams) => Promise<SlashCommandsListResult>;
  /** Backs the `git.files` RPC. Injectable for tests; defaults to `gitFiles.ts`. Throws on failure. */
  getGitFiles?: (params: GitFilesParams) => Promise<GitFilesResult>;
  /** Backs the `fs.read` RPC. Injectable for tests; defaults to `fsRead.ts`. Throws on failure (missing/escaping/binary/directory target). */
  readFile?: (params: FsReadParams) => Promise<FsReadResult>;
  /** Backs the `provider.account` RPC. Injectable for tests; defaults to `providerAccountInfo.ts`. Never throws. */
  getProviderAccountInfo?: (params: ProviderAccountParams) => Promise<ProviderAccountResult>;
  /**
   * Backs the `sleepInhibit.get` RPC. Injectable for tests; defaults to a stub reporting
   * `{supported:false, mode:"off", active:false}` — indistinguishable from "unsupported
   * platform" until the real `sleepInhibit.ts` manager is threaded through. Never throws.
   */
  getSleepInhibit?: (params: SleepInhibitGetParams) => Promise<SleepInhibitState>;
  /** Backs the `sleepInhibit.set` RPC. Same stub default as `getSleepInhibit`. Never throws. */
  setSleepInhibit?: (params: SleepInhibitSetParams) => Promise<SleepInhibitState>;
  /** Performs a takeover/fork adoption (`daemon/adoptTake.ts`'s `handleAdoptTake`, typically) — throws on failure. */
  adoptTake: (params: AdoptTakeParams) => Promise<AdoptTakeResult>;
  /** Reads one chunk of an unmanaged session's transcript (`daemon/transcriptMirror.ts`'s `handleAdoptMirror`, typically) — throws on failure. */
  adoptMirror: (params: AdoptMirrorParams) => Promise<AdoptMirrorResult>;
  /** Backs `preview.ports`. Closes over a per-daemon `tunnelRegistry.ts` instance — no default. Throws on failure. */
  previewPorts: (params: PreviewPortsParams) => Promise<PreviewPortsResult>;
  previewTunnels: (params: PreviewTunnelsParams) => Promise<PreviewTunnelsResult>;
  previewOpen: (params: PreviewOpenParams) => Promise<PreviewOpenResult>;
  previewClose: (params: PreviewCloseParams) => Promise<PreviewCloseResult>;
  /** Backs the `workspace.getConfig` RPC. Injectable for tests; defaults to `workspaceConfigRpc.ts`. Throws on an unauthorized worktree. */
  getWorkspaceConfig?: (params: WorkspaceGetConfigParams) => Promise<WorkspaceGetConfigResult>;
  /** Backs the `workspace.setConfig` RPC (`baseRef`/`remote` only). Injectable for tests; defaults to `workspaceConfigRpc.ts`. Throws on an unauthorized worktree. */
  setWorkspaceConfig?: (params: WorkspaceSetConfigParams) => Promise<WorkspaceSetConfigResult>;
  /** Backs the `run.start` RPC. Injectable for tests; defaults to `runProcess.ts`. Throws on an unauthorized worktree or an unconfigured `runScript`. */
  runStart?: (params: RunStartParams) => Promise<RunStartResult>;
  /** Backs the `run.stop` RPC. Injectable for tests; defaults to `runProcess.ts`. Throws on an unauthorized worktree. */
  runStop?: (params: RunStopParams) => Promise<RunStopResult>;
  /** Backs the `run.status` RPC. Injectable for tests; defaults to `runProcess.ts`. Throws on an unauthorized worktree. */
  runStatus?: (params: RunStatusParams) => Promise<RunStatusResult>;
  /** Backs the `run.setup` RPC. Injectable for tests; defaults to `runProcess.ts`. Throws on an unauthorized worktree. */
  runSetup?: (params: RunSetupParams) => Promise<RunSetupResult>;
  /** Backs the `worktree.remove` RPC. Injectable for tests; defaults to `worktreeRemove.ts`. Throws on an unauthorized/non-worktree path or a git failure. */
  removeWorktree?: (params: WorktreeRemoveParams) => Promise<WorktreeRemoveResult>;
  logger?: Logger;
}

export interface MachineRpcHandle {
  /** Removes this module's listeners from `deps.socket`. Does not close the socket itself. */
  stop: () => void;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function rpcTarget(machineId: string, method: MachineRpcMethod): string {
  return `m:${machineId}:${method}`;
}

/**
 * Sealed `{ok:false, error}` — the uniform error shape for unknown methods,
 * bad params, or a throwing handler. `code` is an optional, additive
 * extension: most handler errors carry none and the
 * shape is unchanged from before; a `WorkspaceValidationError` (thrown by
 * `workspacePath.ts`'s `assertWorkspaceStillValid`) is the first caller to
 * set it, letting the web client render plain-language copy instead of
 * string-matching `error`.
 */
function errorBox(dek: Uint8Array, error: string, code?: string): EncryptedBox {
  return seal(code !== undefined ? { ok: false, error, code } : { ok: false, error }, dek);
}

interface RpcRequestData {
  method?: unknown;
  params?: unknown;
}

/** One machine RPC method's params/result schemas and handler, existentially typed away at the call site (`onRpcRequest`) — every method flows through the exact same decrypt/validate/run/seal pipeline. */
interface MethodSpec<TParams, TResult> {
  paramsSchema: ZodType<TParams>;
  resultSchema: ZodType<TResult>;
  handle: (params: TParams) => Promise<TResult>;
}

function isMachineRpcMethod(method: unknown): method is MachineRpcMethod {
  return typeof method === "string" && (MACHINE_RPC_METHODS as readonly string[]).includes(method);
}

/** Honest "no manager wired" stub for `sleepInhibit.get`/`sleepInhibit.set` — see `MachineRpcDeps`'s own doc comment on why this is indistinguishable from a genuinely unsupported (non-darwin) platform until the real manager is threaded through. */
function unwiredSleepInhibitState(): SleepInhibitState {
  return { supported: false, platform: process.platform, mode: "off", active: false };
}

/**
 * Wraps a handler with idempotency-key replay: a retried call with the
 * same key *and the same params* joins/replays the same attempt instead of
 * re-running the handler. Never caches a rejected call.
 *
 * Keyed on `idempotencyKey` + a JSON snapshot of `params` (both methods'
 * params are plain JSON-safe primitives — see `@kvy/wire`'s `rpc.ts`),
 * not on `idempotencyKey` alone: `adopt.mirror`'s result is a transcript
 * chunk addressed by `cursor`, so a caller that (incorrectly) reused one
 * `idempotencyKey` across a paginated sequence of different cursors must
 * still get each cursor's own chunk rather than silently replaying
 * whichever chunk happened to be cached first for that key. A genuine
 * retry — same key, same params — still replays as intended.
 *
 * Caches the in-flight `Promise`, set synchronously before `fn` is ever
 * awaited — a second call for the same key that arrives *while the first is
 * still running* joins that same promise instead of starting its own
 * redundant attempt (this module's header comment: "concurrency, not just
 * retry-after-the-fact").
 */
function withIdempotencyCache<P extends { idempotencyKey: string }, R>(
  fn: (params: P) => Promise<R>,
): (params: P) => Promise<R> {
  const cache = new Map<string, Promise<R>>();
  return (params: P) => {
    const cacheKey = `${params.idempotencyKey}:${JSON.stringify(params)}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const attempt = fn(params).catch((error: unknown) => {
      cache.delete(cacheKey);
      throw error;
    });
    cache.set(cacheKey, attempt);
    return attempt;
  };
}

/**
 * Resource-keyed in-flight guard, generalized from what was originally
 * `adopt.take`'s own `withProviderSessionGuard` (two devices adopting the
 * same `providerSessionId` with different `idempotencyKey`s must join the
 * same history). Unlike `withIdempotencyCache` above (keyed on the
 * *request* — `idempotencyKey`), this is keyed on the *target* — whatever
 * `keyOf` extracts from `params` (`providerSessionId` for `adopt.take`,
 * `worktree` for `run.start` — two devices pressing play concurrently with
 * different `idempotencyKey`s must join one launch attempt rather than
 * racing two independent `run.start` calls for the same directory). Two calls for the same key
 * that arrive concurrently join the same in-flight attempt and both get its
 * exact result. Never caches a rejected attempt — the map entry is always
 * removed once the attempt settles, success or failure, so the next
 * genuinely-new call for that key runs fresh.
 */
function withResourceGuard<P, R>(
  fn: (params: P) => Promise<R>,
  keyOf: (params: P) => string,
): (params: P) => Promise<R> {
  const inFlight = new Map<string, Promise<R>>();
  return (params: P) => {
    const key = keyOf(params);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const attempt = fn(params).finally(() => inFlight.delete(key));
    inFlight.set(key, attempt);
    return attempt;
  };
}

/** `adopt.take`'s own resource guard, keyed on `providerSessionId` — see `withResourceGuard`'s doc comment. */
function withProviderSessionGuard(
  fn: (params: AdoptTakeParams) => Promise<AdoptTakeResult>,
): (params: AdoptTakeParams) => Promise<AdoptTakeResult> {
  return withResourceGuard(fn, (params) => params.providerSessionId);
}

/**
 * Resource-keyed in-flight guard for `preview.open`, keyed on `params.port`.
 * Two concurrent open requests for the same port join a single `cloudflared`
 * spawn rather than racing independent spawns. Never caches a rejected attempt.
 */
function withPortGuard(
  fn: (params: PreviewOpenParams) => Promise<PreviewOpenResult>,
): (params: PreviewOpenParams) => Promise<PreviewOpenResult> {
  const inFlight = new Map<number, Promise<PreviewOpenResult>>();
  return (params: PreviewOpenParams) => {
    const key = params.port;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const attempt = fn(params).finally(() => inFlight.delete(key));
    inFlight.set(key, attempt);
    return attempt;
  };
}

/**
 * Registers the daemon's machine-scoped `spawn`/`resumeSession`/`fs.list`/
 * `fs.mkdir`/`workspace.register`/`adopt.take`/`adopt.mirror` RPCs: joins
 * `m:<machineId>:<method>`
 * for each on every (re)connect, and answers `rpc-request` by decrypting
 * params, validating against the method's `@kvy/wire` schema, running
 * (or, where applicable, replaying) the handler, and sealing the result
 * back for the server's `emitWithAck` to relay to the caller.
 */
export function registerMachineRpcHandlers(deps: MachineRpcDeps): MachineRpcHandle {
  const logger = deps.logger ?? noopLogger;
  const spawnResults = new Map<string, Promise<SpawnResult>>();
  const listDirectory = deps.listDirectory ?? listDirectoryDefault;
  const createDirectory = deps.createDirectory ?? createDirectoryDefault;
  const registerWorkspace = deps.registerWorkspace ?? registerWorkspaceDefault;
  const unregisterWorkspace = deps.unregisterWorkspace ?? unregisterWorkspaceDefault;
  const getGitStatus = deps.getGitStatus ?? getGitStatusDefault;
  const getGitDiff = deps.getGitDiff ?? getGitDiffDefault;
  const getGitBranches = deps.getGitBranches ?? getGitBranchesDefault;
  const getGitRemotes = deps.getGitRemotes ?? getGitRemotesDefault;
  const listSlashCommands = deps.listSlashCommands ?? listSlashCommandsDefault;
  const getGithubChecks = deps.getGithubChecks ?? getGithubChecksDefault;
  const getGitFiles = deps.getGitFiles ?? getGitFilesDefault;
  const readFile = deps.readFile ?? readFileDefault;
  const getProviderAccountInfo = deps.getProviderAccountInfo ?? getProviderAccountInfoDefault;
  const getSleepInhibit = deps.getSleepInhibit ?? (async () => unwiredSleepInhibitState());
  const setSleepInhibit = deps.setSleepInhibit ?? (async () => unwiredSleepInhibitState());
  const cachedAdoptTake = withIdempotencyCache(withProviderSessionGuard(deps.adoptTake));
  const cachedAdoptMirror = withIdempotencyCache(deps.adoptMirror);
  // `git.commit`/`git.push`/`git.renameBranch` are the first git RPCs that DO
  // need idempotency-key replay caching — unlike their read-only siblings
  // above, a lost-ack retry of a real mutation must replay the prior
  // attempt's result (e.g. the commit's own SHA), never re-run the side
  // effect and mint a second commit/push/rename.
  const cachedGitCommit = withIdempotencyCache(deps.gitCommit ?? handleGitCommitDefault);
  const cachedGitPush = withIdempotencyCache(deps.gitPush ?? handleGitPushDefault);
  const cachedGitRenameBranch = withIdempotencyCache(
    deps.gitRenameBranch ?? handleGitRenameBranchDefault,
  );
  // `git.init`/`git.setRemote` are mutating git RPCs that need idempotency-key
  // replay: a lost-ack retry must replay the prior result, not re-run the effect.
  // `git.init` also gets a worktree-keyed resource guard so two concurrent calls
  // for the same directory collapse into a single `git init` attempt.
  const cachedGitInit = withIdempotencyCache(
    withResourceGuard(deps.gitInit ?? handleGitInitDefault, (params) => params.worktree),
  );
  const cachedGitSetRemote = withIdempotencyCache(deps.gitSetRemote ?? handleGitSetRemoteDefault);
  // `preview.open`'s whole point is a side effect (spawning a `cloudflared`
  // child) — idempotency-key replay PLUS the port-keyed concurrency guard,
  // same two-layer shape as `adopt.take`'s `cachedAdoptTake` above.
  const cachedPreviewOpen = withIdempotencyCache(withPortGuard(deps.previewOpen));
  const getWorkspaceConfig = deps.getWorkspaceConfig ?? handleWorkspaceGetConfigDefault;
  const setWorkspaceConfig = deps.setWorkspaceConfig ?? handleWorkspaceSetConfigDefault;
  // `run.start`/`run.stop`/`run.setup` are mutating RPCs that need
  // idempotency-key replay. `run.start` also gets a worktree-keyed resource
  // guard so two concurrent play presses collapse into one launch. `run.status`
  // is read-only and needs no cache.
  const cachedRunStart = withIdempotencyCache(
    withResourceGuard(deps.runStart ?? handleRunStartDefault, (params) => params.worktree),
  );
  const cachedRunStop = withIdempotencyCache(deps.runStop ?? handleRunStopDefault);
  const cachedRunSetup = withIdempotencyCache(deps.runSetup ?? handleRunSetupDefault);
  const runStatus = deps.runStatus ?? handleRunStatusDefault;
  // `worktree.remove`'s whole point is a side effect (a real `git worktree
  // remove`/`git branch -D`) — same idempotency-key replay reasoning as
  // `git.commit`/`git.push`/`git.renameBranch` above: a lost-ack retry must
  // replay the prior result rather than re-running the removal (harmless
  // here since it's already-removed-safe, but replay is still the correct,
  // uniform contract for a mutating RPC in this family). Also gets the same
  // resource guard as `run.start` — keyed on `params.worktree` — so two
  // devices clicking "Remove" concurrently with different `idempotencyKey`s
  // join one real attempt instead of racing two `git worktree remove` calls
  // against the same directory.
  const cachedRemoveWorktree = withIdempotencyCache(
    withResourceGuard(deps.removeWorktree ?? removeWorktreeDefault, (params) => params.worktree),
  );

  function handleSpawn(params: SpawnParams): Promise<SpawnResult> {
    const cached = spawnResults.get(params.idempotencyKey);
    if (cached) {
      logger.info("[machine-rpc] replaying/joining cached spawn attempt", {
        idempotencyKey: params.idempotencyKey,
      });
      return cached;
    }
    const attempt = deps.spawnSession(params).then(
      (result) => {
        // Only a genuine spawn (a `sessionId` was actually launched) is worth
        // replaying. `requiresApproval` means no process was started —
        // keeping it cached would replay a stale "directory doesn't exist"
        // answer forever once the caller creates the directory and retries
        // with the same key, so it's evicted immediately instead.
        if (!result.sessionId) spawnResults.delete(params.idempotencyKey);
        return result;
      },
      (error: unknown) => {
        spawnResults.delete(params.idempotencyKey);
        throw error;
      },
    );
    // Set synchronously, before `attempt` is ever awaited, so a concurrent
    // call with the same idempotencyKey (arriving before this one finishes)
    // joins this same in-flight attempt instead of double-spawning.
    spawnResults.set(params.idempotencyKey, attempt);
    return attempt;
  }

  /** No idempotency-key replay here — see this module's header comment for why `resumeSession` doesn't need one. */
  async function handleResumeSession(params: { sessionId: string }): Promise<{ ok: true }> {
    await deps.resumeSession(params.sessionId);
    return { ok: true };
  }

  const methods: { [M in MachineRpcMethod]: MethodSpec<unknown, unknown> } = {
    spawn: {
      paramsSchema: SpawnParamsSchema,
      resultSchema: SpawnResultSchema,
      handle: handleSpawn as (params: unknown) => Promise<unknown>,
    },
    resumeSession: {
      paramsSchema: ResumeSessionParamsSchema,
      resultSchema: ResumeSessionResultSchema,
      handle: handleResumeSession as (params: unknown) => Promise<unknown>,
    },
    "fs.list": {
      paramsSchema: FsListParamsSchema,
      resultSchema: FsListResultSchema,
      handle: listDirectory as (params: unknown) => Promise<unknown>,
    },
    "fs.mkdir": {
      paramsSchema: FsMkdirParamsSchema,
      resultSchema: FsMkdirResultSchema,
      handle: createDirectory as (params: unknown) => Promise<unknown>,
    },
    "workspace.register": {
      paramsSchema: WorkspaceRegisterParamsSchema,
      resultSchema: WorkspaceRegisterResultSchema,
      handle: registerWorkspace as (params: unknown) => Promise<unknown>,
    },
    "workspace.unregister": {
      paramsSchema: WorkspaceUnregisterParamsSchema,
      resultSchema: WorkspaceUnregisterResultSchema,
      handle: unregisterWorkspace as (params: unknown) => Promise<unknown>,
    },
    "git.status": {
      paramsSchema: GitStatusParamsSchema,
      resultSchema: GitStatusResultSchema,
      handle: getGitStatus as (params: unknown) => Promise<unknown>,
    },
    "git.diff": {
      paramsSchema: GitDiffParamsSchema,
      resultSchema: GitDiffResultSchema,
      handle: getGitDiff as (params: unknown) => Promise<unknown>,
    },
    "git.branches": {
      paramsSchema: GitBranchesParamsSchema,
      resultSchema: GitBranchesResultSchema,
      handle: getGitBranches as (params: unknown) => Promise<unknown>,
    },
    "git.remotes": {
      paramsSchema: GitRemotesParamsSchema,
      resultSchema: GitRemotesResultSchema,
      handle: getGitRemotes as (params: unknown) => Promise<unknown>,
    },
    "git.files": {
      paramsSchema: GitFilesParamsSchema,
      resultSchema: GitFilesResultSchema,
      handle: getGitFiles as (params: unknown) => Promise<unknown>,
    },
    "fs.read": {
      paramsSchema: FsReadParamsSchema,
      resultSchema: FsReadResultSchema,
      handle: readFile as (params: unknown) => Promise<unknown>,
    },
    "commands.list": {
      paramsSchema: SlashCommandsListParamsSchema,
      resultSchema: SlashCommandsListResultSchema,
      handle: listSlashCommands as (params: unknown) => Promise<unknown>,
    },
    "git.commit": {
      paramsSchema: GitCommitParamsSchema,
      resultSchema: GitCommitResultSchema,
      handle: cachedGitCommit as (params: unknown) => Promise<unknown>,
    },
    "git.push": {
      paramsSchema: GitPushParamsSchema,
      resultSchema: GitPushResultSchema,
      handle: cachedGitPush as (params: unknown) => Promise<unknown>,
    },
    "git.renameBranch": {
      paramsSchema: GitRenameBranchParamsSchema,
      resultSchema: GitRenameBranchResultSchema,
      handle: cachedGitRenameBranch as (params: unknown) => Promise<unknown>,
    },
    "git.init": {
      paramsSchema: GitInitParamsSchema,
      resultSchema: GitInitResultSchema,
      handle: cachedGitInit as (params: unknown) => Promise<unknown>,
    },
    "git.setRemote": {
      paramsSchema: GitSetRemoteParamsSchema,
      resultSchema: GitSetRemoteResultSchema,
      handle: cachedGitSetRemote as (params: unknown) => Promise<unknown>,
    },
    "github.checks": {
      paramsSchema: GithubChecksParamsSchema,
      resultSchema: GithubChecksResultSchema,
      handle: getGithubChecks as (params: unknown) => Promise<unknown>,
    },
    "provider.account": {
      paramsSchema: ProviderAccountParamsSchema,
      resultSchema: ProviderAccountResultSchema,
      handle: getProviderAccountInfo as (params: unknown) => Promise<unknown>,
    },
    "sleepInhibit.get": {
      paramsSchema: SleepInhibitGetParamsSchema,
      resultSchema: SleepInhibitStateSchema,
      handle: getSleepInhibit as (params: unknown) => Promise<unknown>,
    },
    "sleepInhibit.set": {
      paramsSchema: SleepInhibitSetParamsSchema,
      resultSchema: SleepInhibitStateSchema,
      handle: setSleepInhibit as (params: unknown) => Promise<unknown>,
    },
    "adopt.take": {
      paramsSchema: AdoptTakeParamsSchema,
      resultSchema: AdoptTakeResultSchema,
      handle: cachedAdoptTake as (params: unknown) => Promise<unknown>,
    },
    "adopt.mirror": {
      paramsSchema: AdoptMirrorParamsSchema,
      resultSchema: AdoptMirrorResultSchema,
      handle: cachedAdoptMirror as (params: unknown) => Promise<unknown>,
    },
    "preview.ports": {
      paramsSchema: PreviewPortsParamsSchema,
      resultSchema: PreviewPortsResultSchema,
      handle: deps.previewPorts as (params: unknown) => Promise<unknown>,
    },
    "preview.tunnels": {
      paramsSchema: PreviewTunnelsParamsSchema,
      resultSchema: PreviewTunnelsResultSchema,
      handle: deps.previewTunnels as (params: unknown) => Promise<unknown>,
    },
    "preview.open": {
      paramsSchema: PreviewOpenParamsSchema,
      resultSchema: PreviewOpenResultSchema,
      handle: cachedPreviewOpen as (params: unknown) => Promise<unknown>,
    },
    "preview.close": {
      paramsSchema: PreviewCloseParamsSchema,
      resultSchema: PreviewCloseResultSchema,
      handle: deps.previewClose as (params: unknown) => Promise<unknown>,
    },
    "workspace.getConfig": {
      paramsSchema: WorkspaceGetConfigParamsSchema,
      resultSchema: WorkspaceGetConfigResultSchema,
      handle: getWorkspaceConfig as (params: unknown) => Promise<unknown>,
    },
    "workspace.setConfig": {
      paramsSchema: WorkspaceSetConfigParamsSchema,
      resultSchema: WorkspaceSetConfigResultSchema,
      handle: setWorkspaceConfig as (params: unknown) => Promise<unknown>,
    },
    "run.start": {
      paramsSchema: RunStartParamsSchema,
      resultSchema: RunStartResultSchema,
      handle: cachedRunStart as (params: unknown) => Promise<unknown>,
    },
    "run.stop": {
      paramsSchema: RunStopParamsSchema,
      resultSchema: RunStopResultSchema,
      handle: cachedRunStop as (params: unknown) => Promise<unknown>,
    },
    "run.status": {
      paramsSchema: RunStatusParamsSchema,
      resultSchema: RunStatusResultSchema,
      handle: runStatus as (params: unknown) => Promise<unknown>,
    },
    "run.setup": {
      paramsSchema: RunSetupParamsSchema,
      resultSchema: RunSetupResultSchema,
      handle: cachedRunSetup as (params: unknown) => Promise<unknown>,
    },
    "worktree.remove": {
      paramsSchema: WorktreeRemoveParamsSchema,
      resultSchema: WorktreeRemoveResultSchema,
      handle: cachedRemoveWorktree as (params: unknown) => Promise<unknown>,
    },
  };

  function registerAll(): void {
    for (const method of MACHINE_RPC_METHODS) {
      deps.socket.emit("rpc-register", { target: rpcTarget(deps.machineId, method) });
    }
  }

  function onConnect(): void {
    registerAll();
  }

  async function onRpcRequest(
    data: RpcRequestData,
    callback?: (response: EncryptedBox) => void,
  ): Promise<void> {
    const method = data.method;
    if (!isMachineRpcMethod(method)) {
      logger.warn("[machine-rpc] unknown method", { method });
      callback?.(errorBox(deps.dek, "unknown-method"));
      return;
    }
    const spec = methods[method];

    const boxResult = EncryptedBoxSchema.safeParse(data.params);
    if (!boxResult.success) {
      logger.warn("[machine-rpc] malformed params envelope", { method });
      callback?.(errorBox(deps.dek, "malformed-params"));
      return;
    }

    const opened = open(boxResult.data, deps.dek);
    if (opened === null) {
      logger.warn("[machine-rpc] failed to decrypt params", { method });
      callback?.(errorBox(deps.dek, "decrypt-failed"));
      return;
    }

    const parsedParams = spec.paramsSchema.safeParse(opened);
    if (!parsedParams.success) {
      logger.warn("[machine-rpc] params failed schema validation", { method });
      callback?.(errorBox(deps.dek, "invalid-params"));
      return;
    }

    try {
      const result = await spec.handle(parsedParams.data);
      const parsedResult = spec.resultSchema.safeParse(result);
      if (!parsedResult.success) {
        logger.error("[machine-rpc] handler returned a result that fails its own schema", {
          method,
        });
        callback?.(errorBox(deps.dek, "invalid-result"));
        return;
      }
      callback?.(seal(parsedResult.data, deps.dek));
    } catch (error) {
      // Forward the handler's own error message (e.g. `GitExecError`'s git
      // stderr) rather than a generic placeholder — "fatal: not a git repository"
      // is more actionable than an opaque error code.
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof WorkspaceValidationError ? error.code : undefined;
      logger.error("[machine-rpc] handler threw", { method, error: message, code });
      callback?.(errorBox(deps.dek, message, code));
    }
  }

  deps.socket.on("connect", onConnect);
  deps.socket.on("rpc-request", onRpcRequest);
  if (deps.socket.connected) registerAll();

  return {
    stop: () => {
      deps.socket.off("connect", onConnect);
      deps.socket.off("rpc-request", onRpcRequest);
    },
  };
}
