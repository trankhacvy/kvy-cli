/**
 * Typed caller-side client for the daemon's machine-scoped RPCs (design
 * §4.4 "Machine RPCs — registered by the daemon"; plan.md §16 "3.1 Remote
 * spawn" / "4.1 Git panel"): `spawn`, the New Session directory picker's
 * `fs.list`/`fs.mkdir`/`workspace.register` (plan.md §16 "Flow 3 —
 * spawn-fresh-folder-register (Piece A)"), the Git panel's
 * `git.status`/`git.diff`, `git.branches` (docs/features/
 * worktree-isolation.md — the New Session wizard's existing-branch worktree
 * picker), plus the mutating `git.commit`/`git.push`/`git.renameBranch`
 * (docs/features/git-write-actions.md — the Git panel's write actions),
 * `commands.list` ("/" slash-command autocomplete, docs/
 * competitive-notes-omnara.md #18 — `features/slash-commands/`), and
 * `provider.account` (docs/competitive-notes-omnara.md #9 — Settings →
 * Providers' per-machine account card). This is
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
 *
 * `github.checks` (docs/features/github-pr-ci.md "GitHub PR/CI
 * integration", docs/competitive-notes-omnara.md #4) is the Checks tab's
 * data source (`features/github-checks/`) — same read-only, no-
 * idempotency-cache shape as `git.status`/`git.diff`/`git.branches` above.
 *
 * `git.files`/`fs.read` (docs/competitive-notes-omnara.md #5 "Full repo file
 * browser") join the same method table for `features/repo-files/`'s Repo
 * Files sidebar tab: `git.files` lists every worktree-relative path
 * (tracked + untracked-but-not-ignored) for the file tree; `fs.read` fetches
 * one file's content once a path is picked.
 *
 * `sleepInhibit.get`/`sleepInhibit.set` (docs/features/sleep-inhibit.md,
 * docs/competitive-notes-omnara.md #12 "Sleep-inhibit control") back
 * Settings → Machines' per-machine Off/While-on-Power/Always card
 * (`features/machine-settings/`) — both share the one `SleepInhibitState`
 * result shape (`set` returns the post-apply state, no follow-up `get`
 * needed).
 *
 * `workspace.getConfig`/`run.start`/`run.stop`/`run.status`/`run.setup`
 * (docs/features/setup-run-scripts.md "Per-workspace Setup/Run scripts")
 * join the table for `features/run-panel/`: the read-only workspace config
 * surface plus the long-lived, remotely start/stop-able `run.*` process.
 * Same no-idempotency-cache reasoning as `git.status` for
 * `workspace.getConfig`/`run.status` (read-only); `run.start`/`run.stop`/
 * `run.setup` DO carry idempotency-key replay caching daemon-side, same as
 * `git.commit`.
 */
import {
  type AdoptListParamsSchema,
  AdoptListResultSchema,
  type AdoptMirrorParams,
  AdoptMirrorResultSchema,
  type AdoptTakeParams,
  AdoptTakeResultSchema,
  type FsListParams,
  FsListResultSchema,
  type FsMkdirParams,
  FsMkdirResultSchema,
  type FsReadParams,
  FsReadResultSchema,
  type GitBranchesParams,
  GitBranchesResultSchema,
  type GitCommitParams,
  GitCommitResultSchema,
  type GitDiffParams,
  GitDiffResultSchema,
  type GitFilesParams,
  GitFilesResultSchema,
  type GithubChecksParams,
  GithubChecksResultSchema,
  type GitPushParams,
  GitPushResultSchema,
  type GitRenameBranchParams,
  GitRenameBranchResultSchema,
  type GitStatusParams,
  GitStatusResultSchema,
  type ProviderAccountParams,
  ProviderAccountResultSchema,
  type RunSetupParams,
  RunSetupResultSchema,
  type RunStartParams,
  RunStartResultSchema,
  type RunStatusParams,
  RunStatusResultSchema,
  type RunStopParams,
  RunStopResultSchema,
  type SlashCommandsListParams,
  SlashCommandsListResultSchema,
  type SleepInhibitGetParams,
  type SleepInhibitSetParams,
  SleepInhibitStateSchema,
  type SpawnParams,
  SpawnResultSchema,
  type WorkspaceGetConfigParams,
  WorkspaceGetConfigResultSchema,
  type WorkspaceRegisterParams,
  WorkspaceRegisterResultSchema,
} from "@falcon/wire";
import type { ZodType, z } from "zod";
import type { ApiSocket } from "./apiSocket.js";

export type {
  AdoptMirrorParams,
  AdoptTakeParams,
  FsListParams,
  FsMkdirParams,
  FsReadParams,
  GitBranchesParams,
  GitCommitParams,
  GitDiffParams,
  GitFilesParams,
  GithubChecksParams,
  GitPushParams,
  GitRenameBranchParams,
  GitStatusParams,
  ProviderAccountParams,
  RunSetupParams,
  RunStartParams,
  RunStatusParams,
  RunStopParams,
  SlashCommandsListParams,
  SleepInhibitGetParams,
  SleepInhibitSetParams,
  SpawnParams,
  WorkspaceGetConfigParams,
  WorkspaceRegisterParams,
};

export type AdoptListParams = z.infer<typeof AdoptListParamsSchema>;
export type AdoptListResult = z.infer<typeof AdoptListResultSchema>;

/** Params shape per method. */
export interface MachineRpcParams {
  spawn: SpawnParams;
  "fs.list": FsListParams;
  "fs.mkdir": FsMkdirParams;
  "workspace.register": WorkspaceRegisterParams;
  "adopt.list": AdoptListParams;
  "adopt.take": AdoptTakeParams;
  "adopt.mirror": AdoptMirrorParams;
  "git.status": GitStatusParams;
  "git.diff": GitDiffParams;
  "git.branches": GitBranchesParams;
  "git.commit": GitCommitParams;
  "git.push": GitPushParams;
  "git.renameBranch": GitRenameBranchParams;
  "github.checks": GithubChecksParams;
  "commands.list": SlashCommandsListParams;
  "git.files": GitFilesParams;
  "fs.read": FsReadParams;
  "provider.account": ProviderAccountParams;
  "sleepInhibit.get": SleepInhibitGetParams;
  "sleepInhibit.set": SleepInhibitSetParams;
  "workspace.getConfig": WorkspaceGetConfigParams;
  "run.start": RunStartParams;
  "run.stop": RunStopParams;
  "run.status": RunStatusParams;
  "run.setup": RunSetupParams;
}

/** Result shape per method, matching `packages/cli/src/daemon/machineRpc.ts`'s method table. */
export interface MachineRpcResults {
  spawn: import("@falcon/wire").SpawnResult;
  "fs.list": import("@falcon/wire").FsListResult;
  "fs.mkdir": import("@falcon/wire").FsMkdirResult;
  "workspace.register": import("@falcon/wire").WorkspaceRegisterResult;
  "adopt.list": AdoptListResult;
  "adopt.take": import("@falcon/wire").AdoptTakeResult;
  "adopt.mirror": import("@falcon/wire").AdoptMirrorResult;
  "git.status": import("@falcon/wire").GitStatusResult;
  "git.diff": import("@falcon/wire").GitDiffResult;
  "git.branches": import("@falcon/wire").GitBranchesResult;
  "git.commit": import("@falcon/wire").GitCommitResult;
  "git.push": import("@falcon/wire").GitPushResult;
  "git.renameBranch": import("@falcon/wire").GitRenameBranchResult;
  "github.checks": import("@falcon/wire").GithubChecksResult;
  "commands.list": import("@falcon/wire").SlashCommandsListResult;
  "git.files": import("@falcon/wire").GitFilesResult;
  "fs.read": import("@falcon/wire").FsReadResult;
  "provider.account": import("@falcon/wire").ProviderAccountResult;
  "sleepInhibit.get": import("@falcon/wire").SleepInhibitState;
  "sleepInhibit.set": import("@falcon/wire").SleepInhibitState;
  "workspace.getConfig": import("@falcon/wire").WorkspaceGetConfigResult;
  "run.start": import("@falcon/wire").RunStartResult;
  "run.stop": import("@falcon/wire").RunStopResult;
  "run.status": import("@falcon/wire").RunStatusResult;
  "run.setup": import("@falcon/wire").RunSetupResult;
}

export type MachineRpcMethod = keyof MachineRpcParams;

const RESULT_SCHEMAS: { [M in MachineRpcMethod]: ZodType<MachineRpcResults[M]> } = {
  spawn: SpawnResultSchema,
  "fs.list": FsListResultSchema,
  "fs.mkdir": FsMkdirResultSchema,
  "workspace.register": WorkspaceRegisterResultSchema,
  "adopt.list": AdoptListResultSchema,
  "adopt.take": AdoptTakeResultSchema,
  "adopt.mirror": AdoptMirrorResultSchema,
  "git.status": GitStatusResultSchema,
  "git.diff": GitDiffResultSchema,
  "git.branches": GitBranchesResultSchema,
  "git.commit": GitCommitResultSchema,
  "git.push": GitPushResultSchema,
  "git.renameBranch": GitRenameBranchResultSchema,
  "github.checks": GithubChecksResultSchema,
  "commands.list": SlashCommandsListResultSchema,
  "git.files": GitFilesResultSchema,
  "fs.read": FsReadResultSchema,
  "provider.account": ProviderAccountResultSchema,
  "sleepInhibit.get": SleepInhibitStateSchema,
  "sleepInhibit.set": SleepInhibitStateSchema,
  "workspace.getConfig": WorkspaceGetConfigResultSchema,
  "run.start": RunStartResultSchema,
  "run.stop": RunStopResultSchema,
  "run.status": RunStatusResultSchema,
  "run.setup": RunSetupResultSchema,
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

/** Structural check for the daemon's sealed error-box shape — see the call site's doc comment. */
function isHandlerErrorBox(value: unknown): value is { ok: false; error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok: unknown }).ok === false &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  );
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

      // The daemon's own `onRpcRequest` (`daemon/machineRpc.ts`) seals a
      // `{ok:false, error}` box — not a `MachineRpcResults[M]` shape — when
      // the handler rejected/threw or a dispatch-level check failed (bad
      // method/params/etc). Every real success result is sealed bare (no
      // `ok`/`error` envelope — see `RESULT_SCHEMAS`), so this shape is
      // unambiguous. Checked BEFORE schema validation: falling through to
      // `safeParse` here would always fail (an error box never matches a
      // result schema) and replace the handler's real message — e.g. a
      // `GitExecError`'s git stderr, the whole point of docs/features/
      // git-write-actions.md's "not a Falcon abstraction" credential-failure
      // UX — with a useless generic "failed schema validation" string.
      if (isHandlerErrorBox(opened)) {
        throw new MachineRpcError(opened.error, "handler-error");
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
