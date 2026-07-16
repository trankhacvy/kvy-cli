/**
 * Machine-scoped RPC registration for the daemon (design §4.4's "Machine
 * RPCs — registered by the daemon" table; plan.md §16 "3.1 Remote spawn").
 *
 * Mirrors `rpc/sessionRpc.ts`'s registration/decrypt/validate/seal shape
 * (same `rpc-register`/`rpc-request` wire contract, same `EncryptedBox`
 * params/results sealed under the owning DEK), adapted to the
 * machine-scoped `m:<machineId>:<method>` target namespace. `spawn` and the
 * New Session directory picker's `fs.list`/`fs.mkdir` are in scope here —
 * `stopSession`/`resumeSession`/`listSessions`/`git.*`/`fs.read`/`adopt.*`
 * are separate, later plan bullets (§3.2/§3.3/§4.1) and can be added to
 * `MACHINE_RPC_METHODS`/`buildMethodTable` the same way without touching
 * this module's dispatch shape.
 *
 * **Idempotency-key replay** (design: "an RPC retry must NEVER
 * double-spawn"): wraps `deps.spawnSession` in a `Map<idempotencyKey,
 * SpawnResult>` — a retried call with the same key replays the prior
 * *successful* result instead of spawning again. A failed attempt is not
 * cached: the actual non-idempotent side effect is the process spawn
 * itself, so only a result that means a spawn genuinely happened is worth
 * replaying — a validation or timeout failure is safe, and correct, to
 * retry from scratch. `fs.list`/`fs.mkdir` need no such cache — listing is
 * naturally idempotent, and `mkdir -p` succeeds identically on retry.
 */
import { open, seal } from "@falcon/crypto";
import {
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
  type SpawnParams,
  SpawnParamsSchema,
  type SpawnResult,
  SpawnResultSchema,
} from "@falcon/wire";
import type { Socket } from "socket.io-client";
import type { ZodType } from "zod";
import type { Logger } from "../logger.js";
import {
  createDirectory as createDirectoryDefault,
  listDirectory as listDirectoryDefault,
} from "./fsBrowse.js";

export const MACHINE_RPC_METHODS = ["spawn", "fs.list", "fs.mkdir"] as const;
export type MachineRpcMethod = (typeof MACHINE_RPC_METHODS)[number];

export interface MachineRpcDeps {
  machineId: string;
  /** The machine's data-encryption key — RPC params/results are sealed under it, same convention as `rpc/sessionRpc.ts`'s session DEK. */
  dek: Uint8Array;
  socket: Socket;
  /** Performs the actual spawn (`spawnEngine.ts`'s `spawnSession`, typically) — throws (any `Error`) on failure. */
  spawnSession: (params: SpawnParams) => Promise<SpawnResult>;
  /** Backs the `fs.list` directory-picker RPC. Injectable for tests; defaults to `fsBrowse.ts`'s real filesystem listing. Throws on failure. */
  listDirectory?: (params: FsListParams) => Promise<FsListResult>;
  /** Backs the `fs.mkdir` create-directory-approval RPC. Injectable for tests; defaults to `fsBrowse.ts`'s real `mkdir -p`. Throws on failure. */
  createDirectory?: (params: FsMkdirParams) => Promise<FsMkdirResult>;
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
 * Registers the daemon's machine-scoped `spawn`/`fs.list`/`fs.mkdir` RPCs:
 * joins `m:<machineId>:<method>` for each on every (re)connect, and answers
 * `rpc-request` by decrypting params, validating against the method's
 * `@falcon/wire` schema, running (or, for `spawn`, replaying) the handler,
 * and sealing the result back for the server's `emitWithAck` to relay to
 * the caller.
 */
export function registerMachineRpcHandlers(deps: MachineRpcDeps): MachineRpcHandle {
  const logger = deps.logger ?? noopLogger;
  const spawnResults = new Map<string, SpawnResult>();
  const listDirectory = deps.listDirectory ?? listDirectoryDefault;
  const createDirectory = deps.createDirectory ?? createDirectoryDefault;

  async function handleSpawn(params: SpawnParams): Promise<SpawnResult> {
    const cached = spawnResults.get(params.idempotencyKey);
    if (cached) {
      logger.info("[machine-rpc] replaying cached spawn result", {
        idempotencyKey: params.idempotencyKey,
      });
      return cached;
    }
    const result = await deps.spawnSession(params);
    spawnResults.set(params.idempotencyKey, result);
    return result;
  }

  const methods: { [M in MachineRpcMethod]: MethodSpec<unknown, unknown> } = {
    spawn: {
      paramsSchema: SpawnParamsSchema,
      resultSchema: SpawnResultSchema,
      handle: handleSpawn as (params: unknown) => Promise<unknown>,
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
