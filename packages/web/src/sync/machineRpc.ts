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
 * `adopt.list` (kvy-prd.md FR-7.8/FR-9.1-9.2 UC7/UC9) is the New Session
 * wizard's session-import step's data source (`features/new-session/`).
 * `@kvy/wire`'s `rpc.ts` defines its params/result schemas but, unlike
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
 * `preview.ports`/`preview.tunnels`/`preview.open`/`preview.close`
 * (docs/features/dev-server-preview.md — "Live dev-server preview via
 * secure tunnel", docs/competitive-notes-omnara.md #6) back the Preview
 * tab's data source (`features/preview/`): `preview.ports` lists the
 * machine's listening TCP ports plus whether `cloudflared` is installed;
 * `preview.tunnels` lists currently-tracked tunnels; `preview.open`/
 * `preview.close` spawn/kill a Cloudflare quick tunnel for a given port. The
 * resulting tunnel URL is a PUBLIC, unauthenticated link whose traffic is
 * NOT E2E-encrypted (unlike this RPC call itself) — see that feature
 * folder's consent-dialog copy.
 *
 * `resumeSession` (docs/features/session-lifecycle-actions.md Phase 6 —
 * Restart) drives the daemon's `resumeSession` RPC (`daemon/resumeSession.ts`
 * — kills any still-live process for the session, then re-spawns it with
 * `KVY_RECONNECT_*` env). The daemon side has been registered since the
 * spawn-RPC task; this is only the caller-side registry entry, structural
 * clone of `spawn`'s own listing above. Like `adopt.list`, `@kvy/wire`
 * exports no paired `ResumeSessionParams`/`ResumeSessionResult` type
 * aliases — derived locally via `z.infer` instead.
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
  type GitInitParams,
  GitInitResultSchema,
  type GitPushParams,
  GitPushResultSchema,
  type GitRemotesParams,
  GitRemotesResultSchema,
  type GitRenameBranchParams,
  GitRenameBranchResultSchema,
  type GitSetRemoteParams,
  GitSetRemoteResultSchema,
  type GitStatusParams,
  GitStatusResultSchema,
  type PreviewCloseParams,
  PreviewCloseResultSchema,
  type PreviewOpenParams,
  PreviewOpenResultSchema,
  type PreviewPortsParams,
  PreviewPortsResultSchema,
  type PreviewTunnelsParams,
  PreviewTunnelsResultSchema,
  type ProviderAccountParams,
  ProviderAccountResultSchema,
  type ResumeSessionParamsSchema,
  ResumeSessionResultSchema,
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
  type WorkspaceSetConfigParams,
  WorkspaceSetConfigResultSchema,
  type WorkspaceUnregisterParams,
  WorkspaceUnregisterResultSchema,
  type WorktreeRemoveParams,
  WorktreeRemoveResultSchema,
} from "@kvy/wire";
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
  GitInitParams,
  GitPushParams,
  GitRemotesParams,
  GitRenameBranchParams,
  GitSetRemoteParams,
  GitStatusParams,
  PreviewCloseParams,
  PreviewOpenParams,
  PreviewPortsParams,
  PreviewTunnelsParams,
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
  WorkspaceSetConfigParams,
  WorkspaceUnregisterParams,
  WorktreeRemoveParams,
};

export type AdoptListParams = z.infer<typeof AdoptListParamsSchema>;
export type AdoptListResult = z.infer<typeof AdoptListResultSchema>;
export type ResumeSessionParams = z.infer<typeof ResumeSessionParamsSchema>;
export type ResumeSessionResult = z.infer<typeof ResumeSessionResultSchema>;

/** Params shape per method. */
export interface MachineRpcParams {
  spawn: SpawnParams;
  "fs.list": FsListParams;
  "fs.mkdir": FsMkdirParams;
  "workspace.register": WorkspaceRegisterParams;
  "workspace.unregister": WorkspaceUnregisterParams;
  "adopt.list": AdoptListParams;
  "adopt.take": AdoptTakeParams;
  "adopt.mirror": AdoptMirrorParams;
  "git.status": GitStatusParams;
  "git.diff": GitDiffParams;
  "git.branches": GitBranchesParams;
  "git.remotes": GitRemotesParams;
  "git.commit": GitCommitParams;
  "git.push": GitPushParams;
  "git.renameBranch": GitRenameBranchParams;
  "git.init": GitInitParams;
  "git.setRemote": GitSetRemoteParams;
  "github.checks": GithubChecksParams;
  "commands.list": SlashCommandsListParams;
  "git.files": GitFilesParams;
  "fs.read": FsReadParams;
  "provider.account": ProviderAccountParams;
  "preview.ports": PreviewPortsParams;
  "preview.tunnels": PreviewTunnelsParams;
  "preview.open": PreviewOpenParams;
  "preview.close": PreviewCloseParams;
  resumeSession: ResumeSessionParams;
  "sleepInhibit.get": SleepInhibitGetParams;
  "sleepInhibit.set": SleepInhibitSetParams;
  "workspace.getConfig": WorkspaceGetConfigParams;
  "workspace.setConfig": WorkspaceSetConfigParams;
  "run.start": RunStartParams;
  "run.stop": RunStopParams;
  "run.status": RunStatusParams;
  "run.setup": RunSetupParams;
  "worktree.remove": WorktreeRemoveParams;
}

/** Result shape per method, matching `packages/cli/src/daemon/machineRpc.ts`'s method table. */
export interface MachineRpcResults {
  spawn: import("@kvy/wire").SpawnResult;
  "fs.list": import("@kvy/wire").FsListResult;
  "fs.mkdir": import("@kvy/wire").FsMkdirResult;
  "workspace.register": import("@kvy/wire").WorkspaceRegisterResult;
  "workspace.unregister": import("@kvy/wire").WorkspaceUnregisterResult;
  "adopt.list": AdoptListResult;
  "adopt.take": import("@kvy/wire").AdoptTakeResult;
  "adopt.mirror": import("@kvy/wire").AdoptMirrorResult;
  "git.status": import("@kvy/wire").GitStatusResult;
  "git.diff": import("@kvy/wire").GitDiffResult;
  "git.branches": import("@kvy/wire").GitBranchesResult;
  "git.remotes": import("@kvy/wire").GitRemotesResult;
  "git.commit": import("@kvy/wire").GitCommitResult;
  "git.push": import("@kvy/wire").GitPushResult;
  "git.renameBranch": import("@kvy/wire").GitRenameBranchResult;
  "git.init": import("@kvy/wire").GitInitResult;
  "git.setRemote": import("@kvy/wire").GitSetRemoteResult;
  "github.checks": import("@kvy/wire").GithubChecksResult;
  "commands.list": import("@kvy/wire").SlashCommandsListResult;
  "git.files": import("@kvy/wire").GitFilesResult;
  "fs.read": import("@kvy/wire").FsReadResult;
  "provider.account": import("@kvy/wire").ProviderAccountResult;
  "preview.ports": import("@kvy/wire").PreviewPortsResult;
  "preview.tunnels": import("@kvy/wire").PreviewTunnelsResult;
  "preview.open": import("@kvy/wire").PreviewOpenResult;
  "preview.close": import("@kvy/wire").PreviewCloseResult;
  resumeSession: ResumeSessionResult;
  "sleepInhibit.get": import("@kvy/wire").SleepInhibitState;
  "sleepInhibit.set": import("@kvy/wire").SleepInhibitState;
  "workspace.getConfig": import("@kvy/wire").WorkspaceGetConfigResult;
  "workspace.setConfig": import("@kvy/wire").WorkspaceSetConfigResult;
  "run.start": import("@kvy/wire").RunStartResult;
  "run.stop": import("@kvy/wire").RunStopResult;
  "run.status": import("@kvy/wire").RunStatusResult;
  "run.setup": import("@kvy/wire").RunSetupResult;
  "worktree.remove": import("@kvy/wire").WorktreeRemoveResult;
}

export type MachineRpcMethod = keyof MachineRpcParams;

const RESULT_SCHEMAS: { [M in MachineRpcMethod]: ZodType<MachineRpcResults[M]> } = {
  spawn: SpawnResultSchema,
  "fs.list": FsListResultSchema,
  "fs.mkdir": FsMkdirResultSchema,
  "workspace.register": WorkspaceRegisterResultSchema,
  "workspace.unregister": WorkspaceUnregisterResultSchema,
  "adopt.list": AdoptListResultSchema,
  "adopt.take": AdoptTakeResultSchema,
  "adopt.mirror": AdoptMirrorResultSchema,
  "git.status": GitStatusResultSchema,
  "git.diff": GitDiffResultSchema,
  "git.branches": GitBranchesResultSchema,
  "git.remotes": GitRemotesResultSchema,
  "git.commit": GitCommitResultSchema,
  "git.push": GitPushResultSchema,
  "git.renameBranch": GitRenameBranchResultSchema,
  "git.init": GitInitResultSchema,
  "git.setRemote": GitSetRemoteResultSchema,
  "github.checks": GithubChecksResultSchema,
  "commands.list": SlashCommandsListResultSchema,
  "git.files": GitFilesResultSchema,
  "fs.read": FsReadResultSchema,
  "provider.account": ProviderAccountResultSchema,
  "preview.ports": PreviewPortsResultSchema,
  "preview.tunnels": PreviewTunnelsResultSchema,
  "preview.open": PreviewOpenResultSchema,
  "preview.close": PreviewCloseResultSchema,
  resumeSession: ResumeSessionResultSchema,
  "sleepInhibit.get": SleepInhibitStateSchema,
  "sleepInhibit.set": SleepInhibitStateSchema,
  "workspace.getConfig": WorkspaceGetConfigResultSchema,
  "workspace.setConfig": WorkspaceSetConfigResultSchema,
  "run.start": RunStartResultSchema,
  "run.stop": RunStopResultSchema,
  "run.status": RunStatusResultSchema,
  "run.setup": RunSetupResultSchema,
  "worktree.remove": WorktreeRemoveResultSchema,
};

/**
 * Thrown only for a *transport*-level failure — target unreachable, ack
 * timeout, or the sealed result didn't decrypt/validate. `code` here is this
 * client's own transport-stage label (`"rpc-failed"`/`"handler-error"`/etc),
 * NOT the daemon's typed reason. `handlerErrorCode` (known-issues.md #3) is
 * the separate, optional pass-through of the daemon's own error box `code`
 * (e.g. `"workspace-missing"`) — only ever set when `code === "handler-error"`
 * AND the daemon attached one; a plain `GitExecError` or any other thrown
 * handler error leaves it `undefined`, so callers must not assume it's
 * present just because `code === "handler-error"`.
 */
export class MachineRpcError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly handlerErrorCode?: string,
  ) {
    super(message);
    this.name = "MachineRpcError";
  }
}

/** The narrow slice of a crypto-bridge client this needs — real `CryptoBridgeClient` (`@/crypto`) satisfies this structurally once it holds the target machine's unwrapped DEK (loaded the same way a session DEK is, via `setSessionKey(machineRow.dek)` — the wrap format is identical, only the row it came from differs). Declared locally so this module has no compile-time dependency on `@/crypto`, mirroring `sessionRpc.ts`'s `SessionRpcCrypto` seam. */
export interface MachineRpcCrypto {
  seal(data: unknown): Promise<import("@kvy/wire").EncryptedBox>;
  open<T = unknown>(box: import("@kvy/wire").EncryptedBox): Promise<T | null>;
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

/** Structural check for the daemon's sealed error-box shape — see the call site's doc comment. `code` is optional (known-issues.md #3's additive extension to `daemon/machineRpc.ts`'s `errorBox`) — most handler errors still carry none. */
function isHandlerErrorBox(value: unknown): value is { ok: false; error: string; code?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok: unknown }).ok === false &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string" &&
    (!("code" in value) || typeof (value as { code: unknown }).code === "string")
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
      // git-write-actions.md's "not a Kvy abstraction" credential-failure
      // UX — with a useless generic "failed schema validation" string.
      if (isHandlerErrorBox(opened)) {
        throw new MachineRpcError(opened.error, "handler-error", opened.code);
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
