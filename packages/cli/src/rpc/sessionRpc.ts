/**
 * registration: `message`, `interrupt`, `takeControl`, `setMode`,
 * W2.3 "Stop session from the web").
 *
 * target by joining a room, decrypt on receipt, encrypt the reply, ack via
 * callback), adapted to Kvy's actual (already-landed) server contract and
 *
 *  - **Registration payload is `{ target }`, not `{ method }`.** Kvy's
 *    server-side `rpcHandler.ts` (`packages/server/src/app/socket/rpcHandler.ts`,
 *    `rpc-register`/`rpc-unregister` — that's the field name this module
 *    sent.
 *  - **Params/results are `EncryptedBox` objects, not opaque base64
 *    strings.** `@kvy/wire`'s `RpcCallSchema.params: EncryptedBoxSchema`
 *    module seals/opens `{t:'enc', v:1, c}` objects via `@kvy/crypto`'s
 *    `seal`/`open` (the same session DEK the HTTP outbox encrypts messages
 *  - **One handler per method, not a generic bag.** The session RPC
 *    `stop`), so
 *    `registerHandler(method, fn)` free-form registry.
 *  - **Validated against the wire schemas.** Every decrypted params/result
 *    payload is round-tripped through its `@kvy/wire` zod schema — a
 *    malformed call (or a handler returning the wrong shape) is caught here
 *    rather than silently sent as whatever-shape-it-happens-to-be.
 */
import { open, seal } from "@kvy/crypto";
import {
  type EncryptedBox,
  EncryptedBoxSchema,
  InterruptResultSchema,
  MessageRpcParamsSchema,
  MessageRpcResultSchema,
  PermAnswerParamsSchema,
  PermAnswerResultSchema,
  SetModelParamsSchema,
  SetModelResultSchema,
  SetModeParamsSchema,
  SetModeResultSchema,
  StopRpcParamsSchema,
  StopRpcResultSchema,
  TakeControlResultSchema,
} from "@kvy/wire";
import type { Socket } from "socket.io-client";
import { type ZodType, z } from "zod";
import type { Logger } from "../logger.js";

// `@kvy/wire`'s rpc.ts exports the schemas below but not their inferred
// types (unlike SpawnParams/LocalSessionInfo/etc.) — derive them locally
// rather than adding exports to a package outside this task's scope
// (packages/cli/src/{remote,rpc} only).
type MessageRpcParams = z.infer<typeof MessageRpcParamsSchema>;
type MessageRpcResult = z.infer<typeof MessageRpcResultSchema>;
type InterruptResult = z.infer<typeof InterruptResultSchema>;
type TakeControlResult = z.infer<typeof TakeControlResultSchema>;
type SetModeParams = z.infer<typeof SetModeParamsSchema>;
type SetModeResult = z.infer<typeof SetModeResultSchema>;
type SetModelParams = z.infer<typeof SetModelParamsSchema>;
type SetModelResult = z.infer<typeof SetModelResultSchema>;
type PermAnswerParams = z.infer<typeof PermAnswerParamsSchema>;
type PermAnswerResult = z.infer<typeof PermAnswerResultSchema>;
type StopRpcParams = z.infer<typeof StopRpcParamsSchema>;
type StopRpcResult = z.infer<typeof StopRpcResultSchema>;

/**
 * machine-scoped `stopSession`: the session process is alive and owns its
 * own child, so ending it doesn't need a daemon round-trip).
 */
export const SESSION_RPC_METHODS = [
  "message",
  "interrupt",
  "takeControl",
  "setMode",
  "setModel",
  "perm.answer",
  "stop",
] as const;
export type SessionRpcMethod = (typeof SESSION_RPC_METHODS)[number];

export interface SessionRpcHandlers {
  message: (params: MessageRpcParams) => Promise<MessageRpcResult> | MessageRpcResult;
  interrupt: () => Promise<InterruptResult> | InterruptResult;
  takeControl: () => Promise<TakeControlResult> | TakeControlResult;
  setMode: (params: SetModeParams) => Promise<SetModeResult> | SetModeResult;
  setModel: (params: SetModelParams) => Promise<SetModelResult> | SetModelResult;
  permAnswer: (params: PermAnswerParams) => Promise<PermAnswerResult> | PermAnswerResult;
  stop: (params: StopRpcParams) => Promise<StopRpcResult> | StopRpcResult;
}

export interface SessionRpcDeps {
  sessionId: string;
  /** The session's data-encryption key — RPC params/results are sealed under it, same as the HTTP outbox. */
  dek: Uint8Array;
  socket: Socket;
  handlers: SessionRpcHandlers;
  logger?: Logger;
}

export interface SessionRpcHandle {
  /** Removes this module's listeners from `deps.socket`. Does not close the socket itself. */
  stop: () => void;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function rpcTarget(sessionId: string, method: SessionRpcMethod): string {
  return `s:${sessionId}:${method}`;
}

/**
 * One table entry, type-checked at construction (`defineMethod`'s generics
 * tie `paramsSchema`/`resultSchema`/`run` together) but stored behind an
 * erased `MethodSpec<unknown, unknown>` — the table itself is necessarily
 * heterogeneous (five different params/result shapes), so the lookup map
 * can't carry per-method generics the way a single call site can.
 */
interface MethodSpec<TParams, TResult> {
  paramsSchema: ZodType<TParams>;
  resultSchema: ZodType<TResult>;
  run: (params: TParams) => Promise<TResult> | TResult;
}

function defineMethod<TParams, TResult>(
  paramsSchema: ZodType<TParams>,
  resultSchema: ZodType<TResult>,
  run: (params: TParams) => Promise<TResult> | TResult,
): MethodSpec<unknown, unknown> {
  return { paramsSchema, resultSchema, run } as unknown as MethodSpec<unknown, unknown>;
}

const NoParamsSchema = z.object({});

function buildMethodTable(
  handlers: SessionRpcHandlers,
): Record<SessionRpcMethod, MethodSpec<unknown, unknown>> {
  return {
    message: defineMethod(MessageRpcParamsSchema, MessageRpcResultSchema, handlers.message),
    interrupt: defineMethod(NoParamsSchema, InterruptResultSchema, handlers.interrupt),
    takeControl: defineMethod(NoParamsSchema, TakeControlResultSchema, handlers.takeControl),
    setMode: defineMethod(SetModeParamsSchema, SetModeResultSchema, handlers.setMode),
    setModel: defineMethod(SetModelParamsSchema, SetModelResultSchema, handlers.setModel),
    "perm.answer": defineMethod(
      PermAnswerParamsSchema,
      PermAnswerResultSchema,
      handlers.permAnswer,
    ),
    stop: defineMethod(StopRpcParamsSchema, StopRpcResultSchema, handlers.stop),
  };
}

interface RpcRequestData {
  method?: unknown;
  params?: unknown;
}

/** Sealed `{ok:false, error}` — the uniform error shape for unknown methods, bad params, or a throwing handler. */
function errorBox(dek: Uint8Array, error: string): EncryptedBox {
  return seal({ ok: false, error }, dek);
}

/**
 * Registers the five session RPC handlers over `deps.socket`: joins the
 * `s:<sessionId>:<method>` room for each on every (re)connect, and answers
 * `rpc-request` by decrypting params, validating + running the matching
 * handler, and sealing the result back for the server's `emitWithAck` to
 * sees the local half of that contract).
 */
export function registerSessionRpcHandlers(deps: SessionRpcDeps): SessionRpcHandle {
  const logger = deps.logger ?? noopLogger;
  const methods = buildMethodTable(deps.handlers);

  function registerAll(): void {
    for (const method of SESSION_RPC_METHODS) {
      deps.socket.emit("rpc-register", { target: rpcTarget(deps.sessionId, method) });
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
    if (
      typeof method !== "string" ||
      !(SESSION_RPC_METHODS as readonly string[]).includes(method)
    ) {
      logger.warn("[session-rpc] unknown method", { method });
      callback?.(errorBox(deps.dek, "unknown-method"));
      return;
    }

    const spec = methods[method as SessionRpcMethod];

    const boxResult = EncryptedBoxSchema.safeParse(data.params);
    if (!boxResult.success) {
      logger.warn("[session-rpc] malformed params envelope", { method });
      callback?.(errorBox(deps.dek, "malformed-params"));
      return;
    }

    const opened = open(boxResult.data, deps.dek);
    if (opened === null) {
      logger.warn("[session-rpc] failed to decrypt params", { method });
      callback?.(errorBox(deps.dek, "decrypt-failed"));
      return;
    }

    const parsedParams = spec.paramsSchema.safeParse(opened);
    if (!parsedParams.success || parsedParams.data === undefined) {
      logger.warn("[session-rpc] params failed schema validation", { method });
      callback?.(errorBox(deps.dek, "invalid-params"));
      return;
    }

    try {
      const result = await spec.run(parsedParams.data);
      const parsedResult = spec.resultSchema.safeParse(result);
      if (!parsedResult.success) {
        logger.error("[session-rpc] handler returned a result that fails its own schema", {
          method,
        });
        callback?.(errorBox(deps.dek, "invalid-result"));
        return;
      }
      callback?.(seal(parsedResult.data, deps.dek));
    } catch (error) {
      logger.error("[session-rpc] handler threw", {
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
