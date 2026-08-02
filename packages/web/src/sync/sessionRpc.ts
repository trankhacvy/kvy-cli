/**
 * Typed caller-side client for the session RPC methods
 * counterpart to `packages/cli/src/rpc/sessionRpc.ts` (the session-process
 * registration side): seal the params under the session's crypto-bridge
 * key, `apiSocket.rpcCall` to `s:<sessionId>:<method>`, open + validate the
 * sealed result.
 *
 * Only the transport is defined here — `params`/`result` are always an
 * *how* the caller obtained a crypto client with the right session key
 * loaded (that's `@/crypto`'s job, wired in by whatever screen owns a live
 * session — see `features/session-control/`).
 */
import {
  InterruptResultSchema,
  type MessageRpcParamsSchema,
  MessageRpcResultSchema,
  type MessageRpcStatusSchema,
  type PermAnswerParamsSchema,
  PermAnswerResultSchema,
  type SetModelParamsSchema,
  SetModelResultSchema,
  type SetModeParamsSchema,
  SetModeResultSchema,
  type StopRpcParamsSchema,
  StopRpcResultSchema,
  TakeControlResultSchema,
} from "@kvy/wire";
import type { ZodType, z } from "zod";
import type { ApiSocket } from "./apiSocket.js";

export type MessageRpcParams = z.infer<typeof MessageRpcParamsSchema>;
export type MessageRpcResult = z.infer<typeof MessageRpcResultSchema>;
export type MessageRpcStatus = z.infer<typeof MessageRpcStatusSchema>;
export type PermAnswerParams = z.infer<typeof PermAnswerParamsSchema>;
export type PermAnswerResult = z.infer<typeof PermAnswerResultSchema>;
export type SetModeParams = z.infer<typeof SetModeParamsSchema>;
export type SetModeResult = z.infer<typeof SetModeResultSchema>;
export type SetModelParams = z.infer<typeof SetModelParamsSchema>;
export type SetModelResult = z.infer<typeof SetModelResultSchema>;
export type InterruptResult = z.infer<typeof InterruptResultSchema>;
export type TakeControlResult = z.infer<typeof TakeControlResultSchema>;
export type StopRpcParams = z.infer<typeof StopRpcParamsSchema>;
export type StopRpcResult = z.infer<typeof StopRpcResultSchema>;

/** Params shape per method — `interrupt`/`takeControl` take none. */
export interface SessionRpcParams {
  message: MessageRpcParams;
  interrupt: Record<string, never>;
  takeControl: Record<string, never>;
  setMode: SetModeParams;
  setModel: SetModelParams;
  "perm.answer": PermAnswerParams;
  stop: StopRpcParams;
}

/** Result shape per method, matching `packages/cli/src/rpc/sessionRpc.ts`'s
 * `SessionRpcHandlers`. Note `perm.answer`'s `ok` is an *application*-level
 * from the RPC transport's own `RpcCallResult.ok` (did the call reach the
 * target at all). A losing answer is a normal, successful RPC round-trip
 * that resolves here with `{ok: false, reason: 'already-answered', decision}`
 * — it never throws. */
export interface SessionRpcResults {
  message: MessageRpcResult;
  interrupt: InterruptResult;
  takeControl: TakeControlResult;
  setMode: SetModeResult;
  setModel: SetModelResult;
  "perm.answer": PermAnswerResult;
  stop: StopRpcResult;
}

export type SessionRpcMethod = keyof SessionRpcParams;

const RESULT_SCHEMAS: { [M in SessionRpcMethod]: ZodType<SessionRpcResults[M]> } = {
  message: MessageRpcResultSchema,
  interrupt: InterruptResultSchema,
  takeControl: TakeControlResultSchema,
  setMode: SetModeResultSchema,
  setModel: SetModelResultSchema,
  "perm.answer": PermAnswerResultSchema,
  stop: StopRpcResultSchema,
};

/** Thrown only for a *transport*-level failure — target unreachable, ack
 * timeout, or the sealed result didn't decrypt/validate. Never thrown for an
 * application-level `{ok: false}` result (e.g. a denied permission, or a
 * lost first-wins race) — those are normal return values callers branch on. */
export class SessionRpcError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "SessionRpcError";
  }
}

/** The narrow slice of a crypto-bridge client this needs — real
 * `CryptoBridgeClient` (`@/crypto`) satisfies this structurally. Declared
 * locally so this module has no compile-time dependency on `@/crypto`,
 * mirroring `engine.ts`'s `SyncSocketSource` seam. */
export interface SessionRpcCrypto {
  seal(data: unknown): Promise<import("@kvy/wire").EncryptedBox>;
  open<T = unknown>(box: import("@kvy/wire").EncryptedBox): Promise<T | null>;
}

export interface SessionRpcDeps {
  socket: Pick<ApiSocket, "rpcCall">;
  crypto: SessionRpcCrypto;
  sessionId: string;
}

export interface SessionRpcClient {
  call<M extends SessionRpcMethod>(
    method: M,
    params: SessionRpcParams[M],
  ): Promise<SessionRpcResults[M]>;
}

function rpcTarget(sessionId: string, method: SessionRpcMethod): string {
  return `s:${sessionId}:${method}`;
}

export function createSessionRpcClient(deps: SessionRpcDeps): SessionRpcClient {
  return {
    async call(method, params) {
      const box = await deps.crypto.seal(params);
      const response = await deps.socket.rpcCall(rpcTarget(deps.sessionId, method), method, box);

      if (!response.ok) {
        throw new SessionRpcError(response.error, "rpc-failed");
      }

      const opened = await deps.crypto.open<unknown>(response.result);
      if (opened === null) {
        throw new SessionRpcError(`failed to decrypt the '${method}' RPC result`, "decrypt-failed");
      }

      const parsed = RESULT_SCHEMAS[method].safeParse(opened);
      if (!parsed.success) {
        throw new SessionRpcError(
          `'${method}' RPC result failed schema validation`,
          "invalid-result",
        );
      }
      return parsed.data;
    },
  };
}
