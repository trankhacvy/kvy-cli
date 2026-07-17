/**
 * Typed caller-side client for the daemon's machine-scoped RPCs (design
 * §4.4 "Machine RPCs — registered by the daemon"; plan.md §16 "3.1 Remote
 * spawn" / "4.1 Git panel"): `spawn`, the New Session directory picker's
 * `fs.list`/`fs.mkdir`, and the Git panel's `git.status`/`git.diff`. This is
 * the web's counterpart to `packages/cli/src/daemon/machineRpc.ts` (the
 * daemon-side registration), mirroring `sessionRpc.ts`'s shape exactly
 * (seal params under the crypto client's active key, `apiSocket.rpcCall` to
 * `m:<machineId>:<method>`, open + validate the sealed result) but
 * targeting a *machine* instead of a *session*.
 *
 * `MachineRow.dek` (an opaque sealed-box wrap, same convention as
 * `SessionRow.dek`) is unwrapped the same way a session DEK is — see
 * `features/new-session/`'s composition notes for how a caller obtains a
 * `MachineRpcCrypto` scoped to the chosen machine.
 *
 * `adopt.take`/`adopt.mirror` (plan.md §16 "3.3 Session adoption (UC9)")
 * join the same method table below — the daemon-side registration
 * (`packages/cli/src/daemon/machineRpc.ts`) already serves both; this is
 * just the caller-side typing for `features/unmanaged-sessions/`.
 *
 * `adopt.list` (falcon-prd.md FR-7.8/FR-9.1-9.2 UC7/UC9) is the New Session
 * wizard's session-import step's data source (`features/new-session/`).
 * `@falcon/wire`'s `rpc.ts` defines its params/result schemas but, unlike
 * every sibling method here, doesn't export paired `AdoptListParams`/
 * `AdoptListResult` type aliases — so those two are derived locally via
 * `z.infer` instead of imported, same values either way.
 */
import {
  AdoptListParamsSchema,
  AdoptListResultSchema,
  type AdoptMirrorParams,
  AdoptMirrorResultSchema,
  type AdoptTakeParams,
  AdoptTakeResultSchema,
  type FsListParams,
  FsListResultSchema,
  type FsMkdirParams,
  FsMkdirResultSchema,
  type GitDiffParams,
  GitDiffResultSchema,
  type GitStatusParams,
  GitStatusResultSchema,
  type SpawnParams,
  SpawnResultSchema,
} from "@falcon/wire";
import type { z, ZodType } from "zod";
import type { ApiSocket } from "./apiSocket.js";

export type {
  AdoptMirrorParams,
  AdoptTakeParams,
  FsListParams,
  FsMkdirParams,
  GitDiffParams,
  GitStatusParams,
  SpawnParams,
};

export type AdoptListParams = z.infer<typeof AdoptListParamsSchema>;
export type AdoptListResult = z.infer<typeof AdoptListResultSchema>;

/** Params shape per method. */
export interface MachineRpcParams {
  spawn: SpawnParams;
  "fs.list": FsListParams;
  "fs.mkdir": FsMkdirParams;
  "adopt.list": AdoptListParams;
  "adopt.take": AdoptTakeParams;
  "adopt.mirror": AdoptMirrorParams;
  "git.status": GitStatusParams;
  "git.diff": GitDiffParams;
}

/** Result shape per method, matching `packages/cli/src/daemon/machineRpc.ts`'s method table. */
export interface MachineRpcResults {
  spawn: import("@falcon/wire").SpawnResult;
  "fs.list": import("@falcon/wire").FsListResult;
  "fs.mkdir": import("@falcon/wire").FsMkdirResult;
  "adopt.list": AdoptListResult;
  "adopt.take": import("@falcon/wire").AdoptTakeResult;
  "adopt.mirror": import("@falcon/wire").AdoptMirrorResult;
  "git.status": import("@falcon/wire").GitStatusResult;
  "git.diff": import("@falcon/wire").GitDiffResult;
}

export type MachineRpcMethod = keyof MachineRpcParams;

const RESULT_SCHEMAS: { [M in MachineRpcMethod]: ZodType<MachineRpcResults[M]> } = {
  spawn: SpawnResultSchema,
  "fs.list": FsListResultSchema,
  "fs.mkdir": FsMkdirResultSchema,
  "adopt.list": AdoptListResultSchema,
  "adopt.take": AdoptTakeResultSchema,
  "adopt.mirror": AdoptMirrorResultSchema,
  "git.status": GitStatusResultSchema,
  "git.diff": GitDiffResultSchema,
};

/** Thrown only for a *transport*-level failure — target unreachable, ack timeout, or the sealed result didn't decrypt/validate. */
export class MachineRpcError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "MachineRpcError";
  }
}

/** The narrow slice of a crypto-bridge client this needs — real `CryptoBridgeClient` (`@/crypto`) satisfies this structurally once it holds the target machine's unwrapped DEK (loaded the same way a session DEK is, via `setSessionKey(machineRow.dek)` — the wrap format is identical, only the row it came from differs). Declared locally so this module has no compile-time dependency on `@/crypto`, mirroring `sessionRpc.ts`'s `SessionRpcCrypto` seam. */
export interface MachineRpcCrypto {
  seal(data: unknown): Promise<import("@falcon/wire").EncryptedBox>;
  open<T = unknown>(box: import("@falcon/wire").EncryptedBox): Promise<T | null>;
}

export interface MachineRpcDeps {
  socket: Pick<ApiSocket, "rpcCall">;
  crypto: MachineRpcCrypto;
  machineId: string;
}

export interface MachineRpcClient {
  call<M extends MachineRpcMethod>(
    method: M,
    params: MachineRpcParams[M],
  ): Promise<MachineRpcResults[M]>;
}

function rpcTarget(machineId: string, method: MachineRpcMethod): string {
  return `m:${machineId}:${method}`;
}

export function createMachineRpcClient(deps: MachineRpcDeps): MachineRpcClient {
  return {
    async call(method, params) {
      const box = await deps.crypto.seal(params);
      const response = await deps.socket.rpcCall(rpcTarget(deps.machineId, method), method, box);

      if (!response.ok) {
        throw new MachineRpcError(response.error, "rpc-failed");
      }

      const opened = await deps.crypto.open<unknown>(response.result);
      if (opened === null) {
        throw new MachineRpcError(`failed to decrypt the '${method}' RPC result`, "decrypt-failed");
      }

      const parsed = RESULT_SCHEMAS[method].safeParse(opened);
      if (!parsed.success) {
        throw new MachineRpcError(
          `'${method}' RPC result failed schema validation`,
          "invalid-result",
        );
      }
      return parsed.data;
    },
  };
}
