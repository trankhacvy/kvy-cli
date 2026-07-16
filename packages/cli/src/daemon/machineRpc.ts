/**
 * Machine-scoped RPC registration for the daemon (design §4.4's "Machine
 * RPCs — registered by the daemon" table; plan.md §16 "3.1 Remote spawn" /
 * "3.3 Session adoption (UC9)").
 *
 * Mirrors `rpc/sessionRpc.ts`'s registration/decrypt/validate/seal shape
 * (same `rpc-register`/`rpc-request` wire contract, same `EncryptedBox`
 * params/results sealed under the owning DEK), adapted to the
 * machine-scoped `m:<machineId>:<method>` target namespace.
 *
 * `spawn`, `adopt.take`, and `adopt.mirror` are in this task's scope —
 * `stopSession`/`resumeSession`/`listSessions`/`git.*`/`fs.read`/`adopt.list`
 * are separate, later plan bullets (§3.2/§4.1) and can be added to
 * `MACHINE_RPC_METHODS`/`onRpcRequest`'s method switch the same way without
 * touching this module's shape.
 *
 * **Idempotency-key replay** (design: "an RPC retry must NEVER
 * double-spawn"; the same rationale extends to `adopt.take`'s kill+spawn
 * side effect and to `adopt.mirror`'s file read — "or re-reading a file
 * mid-write twice", per `@falcon/wire`'s own `rpc.ts` doc comment): every
 * method's handler is wrapped in its own `Map<idempotencyKey, Result>` — a
 * retried call with the same key replays the prior *successful* result
 * instead of re-running the handler. A failed attempt is never cached: the
 * side effect worth replaying is a handler that actually ran to
 * completion, so a validation/timeout/transient failure is safe (and
 * correct) to retry from scratch.
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
  type SpawnParams,
  SpawnParamsSchema,
  type SpawnResult,
  SpawnResultSchema,
} from "@falcon/wire";
import type { Socket } from "socket.io-client";
import type { z } from "zod";
import type { Logger } from "../logger.js";

export const MACHINE_RPC_METHODS = ["spawn", "adopt.take", "adopt.mirror"] as const;
export type MachineRpcMethod = (typeof MACHINE_RPC_METHODS)[number];

export interface MachineRpcDeps {
  machineId: string;
  /** The machine's data-encryption key — RPC params/results are sealed under it, same convention as `rpc/sessionRpc.ts`'s session DEK. */
  dek: Uint8Array;
  socket: Socket;
  /** Performs the actual spawn (`spawnEngine.ts`'s `spawnSession`, typically) — throws (any `Error`) on failure. */
  spawnSession: (params: SpawnParams) => Promise<SpawnResult>;
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

/** Wraps a handler with idempotency-key replay: a retried call with the same key returns the cached result instead of re-running the handler. Never caches a rejected call. */
function withIdempotencyCache<P extends { idempotencyKey: string }, R>(
  fn: (params: P) => Promise<R>,
): (params: P) => Promise<R> {
  const cache = new Map<string, R>();
  return async (params: P) => {
    const cached = cache.get(params.idempotencyKey);
    if (cached !== undefined) return cached;
    const result = await fn(params);
    cache.set(params.idempotencyKey, result);
    return result;
  };
}

interface MethodEntry<P, R> {
  paramsSchema: z.ZodType<P>;
  resultSchema: z.ZodType<R>;
  run: (params: P) => Promise<R>;
}

/**
 * Runs one method's full decrypt → validate → handle → validate-result →
 * seal pipeline, returning the uniform sealed-error shape at every failure
 * point instead of throwing — the caller (`onRpcRequest`) never needs its
 * own try/catch around this.
 */
async function dispatch<P, R>(
  entry: MethodEntry<P, R>,
  boxParams: unknown,
  dek: Uint8Array,
  logger: Logger,
  method: string,
): Promise<EncryptedBox> {
  const boxResult = EncryptedBoxSchema.safeParse(boxParams);
  if (!boxResult.success) {
    logger.warn("[machine-rpc] malformed params envelope", { method });
    return errorBox(dek, "malformed-params");
  }

  const opened = open(boxResult.data, dek);
  if (opened === null) {
    logger.warn("[machine-rpc] failed to decrypt params", { method });
    return errorBox(dek, "decrypt-failed");
  }

  const parsedParams = entry.paramsSchema.safeParse(opened);
  if (!parsedParams.success) {
    logger.warn("[machine-rpc] params failed schema validation", { method });
    return errorBox(dek, "invalid-params");
  }

  try {
    const result = await entry.run(parsedParams.data);
    const parsedResult = entry.resultSchema.safeParse(result);
    if (!parsedResult.success) {
      logger.error("[machine-rpc] handler returned a result that fails its own schema", { method });
      return errorBox(dek, "invalid-result");
    }
    return seal(parsedResult.data, dek);
  } catch (error) {
    logger.error("[machine-rpc] handler threw", {
      method,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorBox(dek, "handler-error");
  }
}

/**
 * Registers the daemon's machine-scoped RPCs: joins every
 * `m:<machineId>:<method>` room on every (re)connect, and answers
 * `rpc-request` by decrypting params, validating against the method's
 * `@falcon/wire` schema, running (or replaying) the handler, and sealing
 * the result back for the server's `emitWithAck` to relay to the caller.
 */
export function registerMachineRpcHandlers(deps: MachineRpcDeps): MachineRpcHandle {
  const logger = deps.logger ?? noopLogger;

  const cachedSpawn = withIdempotencyCache(deps.spawnSession);
  const cachedAdoptTake = withIdempotencyCache(deps.adoptTake);
  const cachedAdoptMirror = withIdempotencyCache(deps.adoptMirror);

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
    switch (method) {
      case "spawn":
        callback?.(
          await dispatch(
            { paramsSchema: SpawnParamsSchema, resultSchema: SpawnResultSchema, run: cachedSpawn },
            data.params,
            deps.dek,
            logger,
            method,
          ),
        );
        return;
      case "adopt.take":
        callback?.(
          await dispatch(
            {
              paramsSchema: AdoptTakeParamsSchema,
              resultSchema: AdoptTakeResultSchema,
              run: cachedAdoptTake,
            },
            data.params,
            deps.dek,
            logger,
            method,
          ),
        );
        return;
      case "adopt.mirror":
        callback?.(
          await dispatch(
            {
              paramsSchema: AdoptMirrorParamsSchema,
              resultSchema: AdoptMirrorResultSchema,
              run: cachedAdoptMirror,
            },
            data.params,
            deps.dek,
            logger,
            method,
          ),
        );
        return;
      default:
        logger.warn("[machine-rpc] unknown method", { method });
        callback?.(errorBox(deps.dek, "unknown-method"));
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
