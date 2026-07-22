/**
 * Machine-scoped RPC registration for the daemon (design §4.4's "Machine
 * RPCs — registered by the daemon" table; plan.md §16 "3.1 Remote spawn" /
 * "3.3 Session adoption (UC9)").
 *
 * Mirrors `rpc/sessionRpc.ts`'s registration/decrypt/validate/seal shape
 * (same `rpc-register`/`rpc-request` wire contract, same `EncryptedBox`
 * params/results sealed under the owning DEK), adapted to the
 * machine-scoped `m:<machineId>:<method>` target namespace. `spawn`,
 * `resumeSession`, the New Session directory picker's `fs.list`/`fs.mkdir`,
 * that same flow's `workspace.register` (plan.md §16 "Flow 3 —
 * spawn-fresh-folder-register (Piece A)"), session adoption's
 * `adopt.take`/`adopt.mirror`, and the Git panel's `git.status`/`git.diff`
 * (plan.md §16 "4.1 Git panel") — plus `git.branches` (docs/features/
 * worktree-isolation.md, the New Session wizard's existing-branch worktree
 * picker) — are in scope here —
 * `git.commit`/`git.push`/`git.renameBranch` (docs/features/
 * git-write-actions.md — the first *mutating* git RPCs; `git.status`/
 * `git.diff`/`git.branches` above are read-only) round out the Git panel's
 * RPC surface. `stopSession`/`listSessions`/`fs.read`/`adopt.list` are
 * separate, later plan bullets (§3.2) and can be added to
 * `MACHINE_RPC_METHODS`/`methods` the same way without touching this
 * module's dispatch shape.
 *
 * **Idempotency-key replay** (design: "an RPC retry must NEVER
 * double-spawn"; the same rationale extends to `adopt.take`'s kill+spawn
 * side effect and to `adopt.mirror`'s file read — "or re-reading a file
 * mid-write twice", per `@falcon/wire`'s own `rpc.ts` doc comment):
 * `spawn` wraps `deps.spawnSession` in a `Map<idempotencyKey, SpawnResult>`
 * — a retried call with the same key replays the prior *successful* result
 * instead of spawning again. A failed attempt is not cached: the actual
 * non-idempotent side effect is the process spawn itself, so only a result
 * that means a spawn genuinely happened is worth replaying — a validation
 * or timeout failure is safe, and correct, to retry from scratch.
 * `adopt.take`/`adopt.mirror` use the same never-cache-a-failure replay
 * pattern via `withIdempotencyCache` (keyed on `idempotencyKey` + a JSON
 * snapshot of `params` — see that helper's own doc comment for why).
 * `fs.list`/`fs.mkdir` need no such cache — listing is naturally
 * idempotent, and `mkdir -p` succeeds identically on retry.
 * `workspace.register` needs none either, for the same reason as
 * `fs.mkdir`: registering an already-registered directory is a no-op
 * (`workspace/registry.ts`'s own idempotent contract). `git.status`/
 * `git.diff`/`git.branches` need none either, for the same reason as
 * `fs.list`: they only read current repository state, so a retry just
 * re-reads it — unlike `adopt.mirror`'s "re-reading a file mid-write twice"
 * hazard, there's no mid-write file here to race. All three still carry
 * `idempotencyKey` on the wire (design: "every caller-retriable machine RPC
 * carries a caller-minted key") for uniformity with the rest of this RPC
 * family, it's just unused by these handlers.
 * `git.commit`/`git.push`/`git.renameBranch` (docs/features/
 * git-write-actions.md) are the opposite of their read-only siblings just
 * above — they're the first git RPCs whose whole point IS a side effect, so
 * (like `spawn`/`adopt.take`/`adopt.mirror`) they DO need
 * `withIdempotencyCache`: a lost-ack retry of `git.commit` must replay the
 * prior commit's SHA rather than mint a second commit, and likewise for a
 * repeated `git.push`/`git.renameBranch`.
 * `resumeSession`'s wire contract (design §4.4: `'resumeSession'({sessionId})
 * → {ok}`) carries no `idempotencyKey` at all either — unlike `spawn`, a
 * retried resume of the same session is not a "double spawn" risk:
 * `resumeSession.ts` itself always stops any still-live process for that
 * session before relaunching, so a second call just relaunches again rather
 * than creating a duplicate.
 *
 * **Concurrency, not just retry-after-the-fact** (plan.md §16 "4.4
 * Hardening": "double-takeover race"): both the idempotency cache above and
 * `handleSpawn`'s own cache key on *settled* results, not in-flight
 * attempts. Two calls with the same `idempotencyKey` that arrive back to
 * back — before the first has finished running — must still collapse into a
 * single real attempt with both callers sharing its outcome, not just a
 * retry *after* the first one already resolved. Every cache in this module
 * therefore stores the in-flight `Promise` itself (set synchronously, before
 * any `await`), not the eventual value — the second caller finds the first
 * caller's promise already in the map and joins it. A rejected attempt is
 * still evicted (never cached), same as before.
 *
 * That covers same-key concurrency, but `adopt.take`'s divergence guard
 * (design FR-9.4: "never two live continuations of the same history") needs
 * one more guard: two *different* devices adopting the same
 * `providerSessionId` mint two different `idempotencyKey`s, so the
 * idempotency cache alone never sees them as the same call.
 * `withProviderSessionGuard` below adds a second, resource-keyed (not
 * request-keyed) in-flight map on top: whichever `adopt.take` call reaches a
 * given `providerSessionId` first "owns" the takeover; any concurrent call
 * for the same `providerSessionId` — regardless of its `idempotencyKey` —
 * joins that same in-flight attempt and gets its exact result (including any
 * mid-turn `warning`) instead of racing its own independent kill+spawn.
 */
import { open, seal } from "@falcon/crypto";
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
  type GitPushParams,
  GitPushParamsSchema,
  type GitPushResult,
  GitPushResultSchema,
  type GitRenameBranchParams,
  GitRenameBranchParamsSchema,
  type GitRenameBranchResult,
  GitRenameBranchResultSchema,
  type GitStatusParams,
  GitStatusParamsSchema,
  type GitStatusResult,
  GitStatusResultSchema,
  ResumeSessionParamsSchema,
  ResumeSessionResultSchema,
  type SpawnParams,
  SpawnParamsSchema,
  type SpawnResult,
  SpawnResultSchema,
  type WorkspaceRegisterParams,
  WorkspaceRegisterParamsSchema,
  type WorkspaceRegisterResult,
  WorkspaceRegisterResultSchema,
} from "@falcon/wire";
import type { Socket } from "socket.io-client";
import type { ZodType } from "zod";
import type { Logger } from "../logger.js";
import {
  createDirectory as createDirectoryDefault,
  listDirectory as listDirectoryDefault,
} from "./fsBrowse.js";
import { getGitBranches as getGitBranchesDefault } from "./gitBranches.js";
import { handleGitCommit as handleGitCommitDefault } from "./gitCommit.js";
import { getGitDiff as getGitDiffDefault } from "./gitDiff.js";
import { handleGitPush as handleGitPushDefault } from "./gitPush.js";
import { handleGitRenameBranch as handleGitRenameBranchDefault } from "./gitRenameBranch.js";
import { getGitStatus as getGitStatusDefault } from "./gitStatus.js";
import { registerWorkspace as registerWorkspaceDefault } from "./workspaceRegisterRpc.js";

export const MACHINE_RPC_METHODS = [
  "spawn",
  "resumeSession",
  "fs.list",
  "fs.mkdir",
  "workspace.register",
  "git.status",
  "git.diff",
  "git.branches",
  "git.commit",
  "git.push",
  "git.renameBranch",
  "adopt.take",
  "adopt.mirror",
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
  /** Backs the `workspace.register` register-workspace-approval RPC (plan.md §16 "Flow 3 — spawn-fresh-folder-register (Piece A)"). Injectable for tests; defaults to `workspaceRegisterRpc.ts`'s real, already-idempotent `registerWorkspace`. Throws on failure. */
  registerWorkspace?: (params: WorkspaceRegisterParams) => Promise<WorkspaceRegisterResult>;
  /** Backs the `git.status` RPC (Git panel, design §4.4). Injectable for tests; defaults to `gitStatus.ts`'s real `git status --porcelain=v2` parse. Throws on failure (e.g. `worktree` isn't a git repo). */
  getGitStatus?: (params: GitStatusParams) => Promise<GitStatusResult>;
  /** Backs the `git.diff` RPC (Git panel, design §4.4). Injectable for tests; defaults to `gitDiff.ts`'s real `git diff` against the resolved base ref. Throws on failure. */
  getGitDiff?: (params: GitDiffParams) => Promise<GitDiffResult>;
  /** Backs the `git.branches` RPC (New Session wizard's existing-branch worktree picker, docs/features/worktree-isolation.md). Injectable for tests; defaults to `gitBranches.ts`'s real `git for-each-ref` parse. Throws on failure. */
  getGitBranches?: (params: GitBranchesParams) => Promise<GitBranchesResult>;
  /** Backs the `git.commit` RPC (docs/features/git-write-actions.md — the first *mutating* git RPC). Injectable for tests; defaults to `gitCommit.ts`'s real `git add`/`git commit`, gated on the registered-workspace authorizer. Throws on failure. */
  gitCommit?: (params: GitCommitParams) => Promise<GitCommitResult>;
  /** Backs the `git.push` RPC (docs/features/git-write-actions.md). Injectable for tests; defaults to `gitPush.ts`'s real `git push` (`force` maps to `--force-with-lease` only), gated on the registered-workspace authorizer. Throws on failure. */
  gitPush?: (params: GitPushParams) => Promise<GitPushResult>;
  /** Backs the `git.renameBranch` RPC (docs/features/git-write-actions.md). Injectable for tests; defaults to `gitRenameBranch.ts`'s real `git branch -m`, gated on the registered-workspace authorizer. Throws on failure. */
  gitRenameBranch?: (params: GitRenameBranchParams) => Promise<GitRenameBranchResult>;
  /** Performs a takeover/fork adoption (`daemon/adoptTake.ts`'s `handleAdoptTake`, typically) — throws on failure. */
  adoptTake: (params: AdoptTakeParams) => Promise<AdoptTakeResult>;
  /** Reads one chunk of an unmanaged session's transcript (`daemon/transcriptMirror.ts`'s `handleAdoptMirror`, typically) — throws on failure. */
  adoptMirror: (params: AdoptMirrorParams) => Promise<AdoptMirrorResult>;
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

/** Sealed `{ok:false, error}` — the uniform error shape for unknown methods, bad params, or a throwing handler. */
function errorBox(dek: Uint8Array, error: string): EncryptedBox {
  return seal({ ok: false, error }, dek);
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

/**
 * Wraps a handler with idempotency-key replay: a retried call with the
 * same key *and the same params* joins/replays the same attempt instead of
 * re-running the handler. Never caches a rejected call.
 *
 * Keyed on `idempotencyKey` + a JSON snapshot of `params` (both methods'
 * params are plain JSON-safe primitives — see `@falcon/wire`'s `rpc.ts`),
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
 * Resource-keyed in-flight guard for `adopt.take` (design FR-9.4: "never two
 * live continuations of the same history"): unlike `withIdempotencyCache`
 * above (keyed on the *request* — `idempotencyKey`), this is keyed on the
 * *target* — `providerSessionId`. Two `adopt.take` calls for the same
 * provider session that arrive concurrently, even with two different
 * `idempotencyKey`s (the realistic "two devices both hit take-over"
 * shape — each mints its own key), join the same in-flight kill+spawn
 * attempt and both get its exact result rather than each running its own
 * independent takeover. Never caches a rejected attempt — the map entry is
 * always removed once the attempt settles, success or failure, so the next
 * genuinely-new takeover of that provider session runs fresh.
 */
function withProviderSessionGuard(
  fn: (params: AdoptTakeParams) => Promise<AdoptTakeResult>,
): (params: AdoptTakeParams) => Promise<AdoptTakeResult> {
  const inFlight = new Map<string, Promise<AdoptTakeResult>>();
  return (params: AdoptTakeParams) => {
    const key = params.providerSessionId;
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
 * params, validating against the method's `@falcon/wire` schema, running
 * (or, where applicable, replaying) the handler, and sealing the result
 * back for the server's `emitWithAck` to relay to the caller.
 */
export function registerMachineRpcHandlers(deps: MachineRpcDeps): MachineRpcHandle {
  const logger = deps.logger ?? noopLogger;
  const spawnResults = new Map<string, Promise<SpawnResult>>();
  const listDirectory = deps.listDirectory ?? listDirectoryDefault;
  const createDirectory = deps.createDirectory ?? createDirectoryDefault;
  const registerWorkspace = deps.registerWorkspace ?? registerWorkspaceDefault;
  const getGitStatus = deps.getGitStatus ?? getGitStatusDefault;
  const getGitDiff = deps.getGitDiff ?? getGitDiffDefault;
  const getGitBranches = deps.getGitBranches ?? getGitBranchesDefault;
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
      logger.error("[machine-rpc] handler threw", {
        method,
        error: error instanceof Error ? error.message : String(error),
      });
      callback?.(errorBox(deps.dek, "handler-error"));
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
