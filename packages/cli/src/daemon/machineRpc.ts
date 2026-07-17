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
 * session adoption's `adopt.take`/`adopt.mirror`, and the Git panel's
 * `git.status`/`git.diff` (plan.md §16 "4.1 Git panel") are in scope here —
 * `stopSession`/`listSessions`/`fs.read`/`adopt.list` are separate, later
 * plan bullets (§3.2) and can be added to `MACHINE_RPC_METHODS`/`methods`
 * the same way without touching this module's dispatch shape.
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
 * idempotent, and `mkdir -p` succeeds identically on retry. `git.status`/
 * `git.diff` need none either, for the same reason as `fs.list`: they only
 * read current repository state, so a retry just re-reads it — unlike
 * `adopt.mirror`'s "re-reading a file mid-write twice" hazard, there's no
 * mid-write file here to race. Both still carry `idempotencyKey` on the
 * wire (design: "every caller-retriable machine RPC carries a caller-minted
 * key") for uniformity with the rest of this RPC family, it's just unused
 * by these two handlers.
 * `resumeSession`'s wire contract (design §4.4: `'resumeSession'({sessionId})
 * → {ok}`) carries no `idempotencyKey` at all either — unlike `spawn`, a
 * retried resume of the same session is not a "double spawn" risk:
 * `resumeSession.ts` itself always stops any still-live process for that
 * session before relaunching, so a second call just relaunches again rather
 * than creating a duplicate.
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
  type GitDiffParams,
  GitDiffParamsSchema,
  type GitDiffResult,
  GitDiffResultSchema,
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
} from "@falcon/wire";
import type { Socket } from "socket.io-client";
import type { ZodType } from "zod";
import type { Logger } from "../logger.js";
import { getGitDiff as getGitDiffDefault } from "./gitDiff.js";
import { getGitStatus as getGitStatusDefault } from "./gitStatus.js";
import {
  createDirectory as createDirectoryDefault,
  listDirectory as listDirectoryDefault,
} from "./fsBrowse.js";

export const MACHINE_RPC_METHODS = [
  "spawn",
  "resumeSession",
  "fs.list",
  "fs.mkdir",
  "git.status",
  "git.diff",
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
  /** Backs the `git.status` RPC (Git panel, design §4.4). Injectable for tests; defaults to `gitStatus.ts`'s real `git status --porcelain=v2` parse. Throws on failure (e.g. `worktree` isn't a git repo). */
  getGitStatus?: (params: GitStatusParams) => Promise<GitStatusResult>;
  /** Backs the `git.diff` RPC (Git panel, design §4.4). Injectable for tests; defaults to `gitDiff.ts`'s real `git diff` against the resolved base ref. Throws on failure. */
  getGitDiff?: (params: GitDiffParams) => Promise<GitDiffResult>;
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
 * same key *and the same params* returns the cached result instead of
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
 */
function withIdempotencyCache<P extends { idempotencyKey: string }, R>(
  fn: (params: P) => Promise<R>,
): (params: P) => Promise<R> {
  const cache = new Map<string, R>();
  return async (params: P) => {
    const cacheKey = `${params.idempotencyKey}:${JSON.stringify(params)}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = await fn(params);
    cache.set(cacheKey, result);
    return result;
  };
}

/**
 * Registers the daemon's machine-scoped `spawn`/`resumeSession`/`fs.list`/
 * `fs.mkdir`/`adopt.take`/`adopt.mirror` RPCs: joins `m:<machineId>:<method>`
 * for each on every (re)connect, and answers `rpc-request` by decrypting
 * params, validating against the method's `@falcon/wire` schema, running
 * (or, where applicable, replaying) the handler, and sealing the result
 * back for the server's `emitWithAck` to relay to the caller.
 */
export function registerMachineRpcHandlers(deps: MachineRpcDeps): MachineRpcHandle {
  const logger = deps.logger ?? noopLogger;
  const spawnResults = new Map<string, SpawnResult>();
  const listDirectory = deps.listDirectory ?? listDirectoryDefault;
  const createDirectory = deps.createDirectory ?? createDirectoryDefault;
  const getGitStatus = deps.getGitStatus ?? getGitStatusDefault;
  const getGitDiff = deps.getGitDiff ?? getGitDiffDefault;
  const cachedAdoptTake = withIdempotencyCache(deps.adoptTake);
  const cachedAdoptMirror = withIdempotencyCache(deps.adoptMirror);

  async function handleSpawn(params: SpawnParams): Promise<SpawnResult> {
    const cached = spawnResults.get(params.idempotencyKey);
    if (cached) {
      logger.info("[machine-rpc] replaying cached spawn result", {
        idempotencyKey: params.idempotencyKey,
      });
      return cached;
    }
    const result = await deps.spawnSession(params);
    // Only a genuine spawn (a `sessionId` was actually launched) is worth
    // replaying. `requiresApproval` means no process was started — caching
    // it would replay a stale "directory doesn't exist" answer forever once
    // the caller creates the directory and retries with the same key.
    if (result.sessionId) {
      spawnResults.set(params.idempotencyKey, result);
    }
    return result;
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
