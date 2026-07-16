/**
 * Machine-scoped RPC registration for the daemon (design §4.4's "Machine
 * RPCs — registered by the daemon" table; plan.md §16 "3.1 Remote spawn").
 *
 * Mirrors `rpc/sessionRpc.ts`'s registration/decrypt/validate/seal shape
 * (same `rpc-register`/`rpc-request` wire contract, same `EncryptedBox`
 * params/results sealed under the owning DEK), adapted to the
 * machine-scoped `m:<machineId>:<method>` target namespace. Only `spawn` is
 * in this task's scope — `stopSession`/`resumeSession`/`listSessions`/
 * `git.*`/`fs.read`/`adopt.*` are separate, later plan bullets (§3.2/§3.3/
 * §4.1) and can be added to `MACHINE_RPC_METHODS`/the method table the same
 * way without touching this module's shape.
 *
 * **Idempotency-key replay** (design: "an RPC retry must NEVER
 * double-spawn"): wraps `deps.spawnSession` in a `Map<idempotencyKey,
 * SpawnResult>` — a retried call with the same key replays the prior
 * *successful* result instead of spawning again. A failed attempt is not
 * cached: the actual non-idempotent side effect is the process spawn
 * itself, so only a result that means a spawn genuinely happened is worth
 * replaying — a validation or timeout failure is safe, and correct, to
 * retry from scratch.
 */
import { open, seal } from "@falcon/crypto";
import {
  type EncryptedBox,
  EncryptedBoxSchema,
  type SpawnParams,
  SpawnParamsSchema,
  type SpawnResult,
  SpawnResultSchema,
} from "@falcon/wire";
import type { Socket } from "socket.io-client";
import type { Logger } from "../logger.js";

export const MACHINE_RPC_METHODS = ["spawn"] as const;
export type MachineRpcMethod = (typeof MACHINE_RPC_METHODS)[number];

export interface MachineRpcDeps {
  machineId: string;
  /** The machine's data-encryption key — RPC params/results are sealed under it, same convention as `rpc/sessionRpc.ts`'s session DEK. */
  dek: Uint8Array;
  socket: Socket;
  /** Performs the actual spawn (`spawnEngine.ts`'s `spawnSession`, typically) — throws (any `Error`) on failure. */
  spawnSession: (params: SpawnParams) => Promise<SpawnResult>;
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

/** Sealed `{ok:false, error}` — the uniform error shape for unknown methods, bad params, or a throwing spawn. */
function errorBox(dek: Uint8Array, error: string): EncryptedBox {
  return seal({ ok: false, error }, dek);
}

interface RpcRequestData {
  method?: unknown;
  params?: unknown;
}

/**
 * Registers the daemon's machine-scoped `spawn` RPC: joins
 * `m:<machineId>:spawn` on every (re)connect, and answers `rpc-request` by
 * decrypting params, validating against `@falcon/wire`'s `SpawnParamsSchema`,
 * running (or replaying) the spawn, and sealing the result back for the
 * server's `emitWithAck` to relay to the caller.
 */
export function registerMachineRpcHandlers(deps: MachineRpcDeps): MachineRpcHandle {
  const logger = deps.logger ?? noopLogger;
  const spawnResults = new Map<string, SpawnResult>();

  function registerAll(): void {
    for (const method of MACHINE_RPC_METHODS) {
      deps.socket.emit("rpc-register", { target: rpcTarget(deps.machineId, method) });
    }
  }

  function onConnect(): void {
    registerAll();
  }

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

  async function onRpcRequest(
    data: RpcRequestData,
    callback?: (response: EncryptedBox) => void,
  ): Promise<void> {
    const method = data.method;
    if (method !== "spawn") {
      logger.warn("[machine-rpc] unknown method", { method });
      callback?.(errorBox(deps.dek, "unknown-method"));
      return;
    }

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

    const parsedParams = SpawnParamsSchema.safeParse(opened);
    if (!parsedParams.success) {
      logger.warn("[machine-rpc] params failed schema validation", { method });
      callback?.(errorBox(deps.dek, "invalid-params"));
      return;
    }

    try {
      const result = await handleSpawn(parsedParams.data);
      const parsedResult = SpawnResultSchema.safeParse(result);
      if (!parsedResult.success) {
        logger.error("[machine-rpc] spawnSession returned a result that fails its own schema", {
          method,
        });
        callback?.(errorBox(deps.dek, "invalid-result"));
        return;
      }
      callback?.(seal(parsedResult.data, deps.dek));
    } catch (error) {
      logger.error("[machine-rpc] spawnSession threw", {
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
