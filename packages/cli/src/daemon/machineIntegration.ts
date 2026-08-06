import {
  decodeBase64,
  deriveBlobKey,
  deriveKeyTree,
  encodeBase64,
  getRandomBytes,
  unwrapDek,
  wrapDek,
} from "@kvy/crypto";
import type {
  AdoptMirrorParams,
  AdoptMirrorResult,
  AdoptTakeParams,
  AdoptTakeResult,
  GitDiffParams,
  GitDiffResult,
  PreviewCloseParams,
  PreviewCloseResult,
  PreviewOpenParams,
  PreviewOpenResult,
  PreviewPortsParams,
  PreviewPortsResult,
  PreviewTunnelsParams,
  PreviewTunnelsResult,
  RunSetupParams,
  RunSetupResult,
  RunStartParams,
  RunStartResult,
  RunStatusParams,
  RunStatusResult,
  RunStopParams,
  RunStopResult,
  SleepInhibitGetParams,
  SleepInhibitSetParams,
  SleepInhibitState,
  SpawnParams,
  SpawnResult,
  WorkspaceGetConfigParams,
  WorkspaceGetConfigResult,
} from "@kvy/wire";
import type { Socket } from "socket.io-client";
import { reportSessionStatus } from "../api/sessionStatus.js";
import type { KvyCredentials } from "../auth/credentials.js";
import { writeCredentials } from "../auth/credentials.js";
import { withCredentialsLock } from "../auth/credentialsLock.js";
import { resolveKeyMaterial } from "../auth/keyMaterial.js";
import { createTokenProvider, type TokenProvider } from "../auth/tokenProvider.js";
import type { Logger } from "../logger.js";
import { resolveServerWorkspaceId } from "../session/resolveServerWorkspaceId.js";
import { createAdoptTakeDeps, handleAdoptTake } from "./adoptTake.js";
import { createBlobClientDeps, uploadBlob as uploadBlobToServer } from "./blobClient.js";
import { getGitDiff } from "./gitDiff.js";
import { createMachineClientDeps, startMachineClient } from "./machineClient.js";
import { registerMachineRpcHandlers } from "./machineRpc.js";
import {
  closeAllTunnels,
  createPreviewTunnelDeps,
  handlePreviewClose,
  handlePreviewOpen,
  handlePreviewPorts,
  handlePreviewTunnels,
} from "./previewTunnel.js";
import type { ProviderSessionResolver } from "./providerSessionResolver.js";
import {
  type ResumeSessionDeps,
  type ResumeSessionRegistry,
  resolveResumeDirectoryFromRecord,
  resumeSession as resumeSessionCore,
} from "./resumeSession.js";
import { handleRunSetup, handleRunStart, handleRunStatus, handleRunStop } from "./runProcess.js";
import type { PersistedSession } from "./sessionsStore.js";
import { runSetupScript } from "./setupScript.js";
import type { SpawnAwaiter } from "./spawnAwaiter.js";
import {
  type SpawnEngineDeps,
  scanForLiveSessionInDirectory,
  spawnSession as spawnSessionCore,
} from "./spawnEngine.js";
import { readDaemonState, writeDaemonState } from "./state.js";
import {
  createTranscriptIndexerDeps,
  type RegisteredWorkspace,
  startTranscriptIndexer,
  type TranscriptIndexerHandle,
} from "./transcriptIndexer.js";
import { handleAdoptMirror } from "./transcriptMirror.js";
import { createTunnelRegistry, reapOrphanedTunnels } from "./tunnelRegistry.js";
import type { ProcessExitWatcher, TrackedSession } from "./types.js";
import {
  createUnmanagedSessionClientDeps,
  upsertUnmanagedSession,
} from "./unmanagedSessionClient.js";
import { handleWorkspaceGetConfig } from "./workspaceConfigRpc.js";
import type { WorkspaceRootLookup } from "./workspacePath.js";

const DEK_LENGTH_BYTES = 32;
/** `deriveKeyTree`'s hierarchy only produces a meaningful content keypair from a full 32-byte masterSecret — a reduced-custody pairing bundle (see `auth/status.ts`'s own same check) can't derive one, so this is a hard requirement here rather than a best-effort guess. */
const MASTER_SECRET_LENGTH_BYTES = 32;

export interface MachineIntegrationDeps {
  homeDir: string;
  logger: Logger;
  serverUrl: string;
  /** Injectable so tests never make a real network call. */
  fetchImpl: typeof fetch;
  /** Injectable so tests can connect to a fake/local server instead of the real relay; production passes `socket.io-client`'s `io`. */
  ioFactory: (url: string, opts: Record<string, unknown>) => Socket;
  /** Reads `~/.kvy/access.key`; `null` means "not logged in" (local-only mode). */
  readCredentials: () => KvyCredentials | null;
  resolveWorkspaceRoot: WorkspaceRootLookup;
  /** Lists every registered workspace, for the transcript indexer's boot-time (and periodic re-scan) fs-watch. Defaults to "nothing registered" here — `daemon/commands.ts` supplies the real registry. See module header. */
  listWorkspaces: () => Promise<RegisteredWorkspace[]>;
  /** Resolves `adopt.take`/`adopt.mirror`'s bare provider session id back to a registered workspace. No real default yet — see module header. */
  resolveProviderSession: ProviderSessionResolver;
  /** Resolves the working directory to relaunch a `resumeSession` RPC's target in, from its persisted record. Defaults to `resumeSession.ts`'s `resolveResumeDirectoryFromRecord` — re-`realpath`s the persisted `directory` (honestly fails, returning `undefined`, when it's unset or no longer resolvable, rather than guessing). */
  resolveResumeDirectory: (
    session: PersistedSession,
  ) => string | null | undefined | Promise<string | null | undefined>;
  heartbeatIntervalMs: number;
  registry: ResumeSessionRegistry & {
    getSessions(): TrackedSession[];
    /** Backs the transcript indexer's `isManaged` hook below — see `sessionRegistry.ts`'s own doc comment. */
    isProviderSessionManaged(providerSessionId: string): boolean;
  };
  awaiter: SpawnAwaiter;
  /** Test-only escape hatch: extra overrides merged into `spawnEngine.ts`'s deps (e.g. a fake process launcher). Production leaves this unset — `spawnEngine.ts`'s own real defaults (tmux/detached launch) apply. */
  spawnEngineOverrides?: Partial<SpawnEngineDeps>;
  /** Same, for `resumeSession.ts`. */
  resumeSessionOverrides?: Partial<ResumeSessionDeps>;
  /** Backs the `sleepInhibit.get` RPC. Defaults to an honest "no manager wired" stub here — `commands.ts` supplies the real `daemon/sleepInhibit.ts` manager's `getState`, since the manager itself is created at that composition root (boot re-apply must work even in local-only mode, where this module's `startMachineIntegration` never runs at all). */
  getSleepInhibit?: (params: SleepInhibitGetParams) => Promise<SleepInhibitState>;
  /** Backs the `sleepInhibit.set` RPC. Same "real default lives in commands.ts" note as `getSleepInhibit` above. */
  setSleepInhibit?: (params: SleepInhibitSetParams) => Promise<SleepInhibitState>;
}

export interface MachineIntegrationHandle {
  readonly machineId: string;
  /**
   * Async because it now also closes every tracked preview tunnel
   * (`previewTunnel.ts`'s `closeAllTunnels`) before tearing down the socket; `commands.ts`'s
   * shutdown path awaits it. Still allowed to return plain `void` for the
   * "socket connected but no RPC handlers ever got wired" defensive branch
   * below, which has no tunnel registry to close.
   */
  stop: () => void | Promise<void>;
}

function defaultLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/** Honest "no manager wired" stub — see `MachineIntegrationDeps.getSleepInhibit`'s own doc comment for why the real default lives in `commands.ts` instead of here. */
async function defaultSleepInhibitStub(): Promise<SleepInhibitState> {
  return { supported: false, platform: process.platform, mode: "off", active: false };
}

export function createMachineIntegrationDeps(
  required: Pick<MachineIntegrationDeps, "homeDir" | "registry" | "awaiter">,
  overrides: Partial<MachineIntegrationDeps> = {},
): MachineIntegrationDeps {
  return {
    logger: defaultLogger(),
    serverUrl: "",
    fetchImpl: fetch,
    ioFactory: () => {
      throw new Error("MachineIntegrationDeps.ioFactory must be provided");
    },
    readCredentials: () => null,
    resolveWorkspaceRoot: () => null,
    listWorkspaces: async () => [],
    resolveProviderSession: async () => null,
    resolveResumeDirectory: resolveResumeDirectoryFromRecord,
    heartbeatIntervalMs: 60_000,
    getSleepInhibit: defaultSleepInhibitStub,
    setSleepInhibit: defaultSleepInhibitStub,
    ...required,
    ...overrides,
  };
}

/**
 * Registers (or resumes) this machine, opens the machine-scoped `/v1/stream`
 * socket, and binds every machine RPC handler to it. Returns `null` (no
 * daemon-side error, just nothing to do) when there are no stored
 * credentials, or when registration itself fails — either way the caller
 * keeps running local-only rather than crashing the whole daemon over an
 * optional, server-dependent feature.
 */
export async function startMachineIntegration(
  deps: MachineIntegrationDeps,
): Promise<MachineIntegrationHandle | null> {
  const credentials = deps.readCredentials();
  if (!credentials) {
    deps.logger.info(
      "[machine-integration] no stored credentials, skipping machine client (local-only mode)",
    );
    return null;
  }

  // every HTTP side-channel client below — a rotated refresh token is persisted back to
  // `~/.kvy/access.key` immediately so a daemon restart resumes from the latest one,
  // not a stale one that a prior refresh already superseded.
  const tokenProvider: TokenProvider = createTokenProvider({
    backendUrl: deps.serverUrl,
    refreshToken: credentials.refreshToken,
    fetchImpl: deps.fetchImpl,
    now: () => Date.now(),
    onRotate: (refreshToken) => {
      writeCredentials({ ...credentials, refreshToken }, deps.homeDir);
    },
    logger: deps.logger,
    // This daemon-owned provider and
    // a foreground `kvy claude`/`kvy codex` session's own provider
    // (`resolveAccessToken.ts`) both rotate the same on-disk refresh token
    // independently — re-read it on a 401 before giving up permanently, in case the
    // other process already rotated in a newer one.
    readCurrentRefreshToken: () => deps.readCredentials()?.refreshToken ?? null,
    // Serialize actual refresh attempts against a foreground
    // session's own provider instead of racing on the same on-disk refresh token.
    withCredentialsLock: (fn) => withCredentialsLock(deps.homeDir, fn),
  });

  // type a PIN), so it can only ever unwrap `"device"` (its own default, OS-Keychain
  // custody) or `"plaintext-fallback"` key material — `resolveKeyMaterial` returns
  // `null` for `"pin"` mode without `pinDeps`, exactly the "skip, don't hang" behavior
  // this needs.
  const masterSecret = await resolveKeyMaterial(credentials.keyMaterial, deps.homeDir);
  if (!masterSecret || masterSecret.length !== MASTER_SECRET_LENGTH_BYTES) {
    deps.logger.warn(
      "[machine-integration] stored credentials are not an unwrappable full masterSecret (PIN-protected with no one to prompt, or a reduced-custody pairing bundle) — skipping machine client",
    );
    return null;
  }
  const keyTree = deriveKeyTree(masterSecret);

  // Reuse the DEK persisted by a previous boot (`state.ts`'s `wrappedDek`),
  // when there is one, instead of always minting a fresh one. `POST
  // /v1/machines`'s CAS-update path (a resumed `machineId`) never re-sends
  // or rotates `dek` — the server keeps whatever was stored on first
  // registration forever (see `machines.ts`'s own doc comment) — so a
  // restarted daemon that minted a *different* local DEK here would
  // silently desync from the one the server (and any other real client
  // unwrapping the machine row with this same masterSecret) actually uses,
  // breaking every machine RPC's decrypt after the very next restart.
  // `unwrapDek` is null-safe (never throws), so a corrupted/foreign value
  // just falls back to minting fresh rather than crashing the daemon.
  const previousState = await readDaemonState(deps.homeDir);
  const previousWrappedDek = previousState?.wrappedDek;
  const reusedDek = previousWrappedDek
    ? unwrapDek(decodeBase64(previousWrappedDek), keyTree.content.secretKey)
    : null;
  let dek: Uint8Array;
  let wrappedDek: string;
  if (reusedDek && previousWrappedDek) {
    dek = reusedDek;
    wrappedDek = previousWrappedDek;
  } else {
    dek = getRandomBytes(DEK_LENGTH_BYTES);
    wrappedDek = encodeBase64(wrapDek(dek, keyTree.content.publicKey));
  }

  let capturedSocket: Socket | undefined;
  const machineDeps = createMachineClientDeps(
    {
      serverUrl: deps.serverUrl,
      tokenProvider,
      homeDir: deps.homeDir,
      encryptionKey: dek,
      encryptionVariant: "dataKey",
      dek: wrappedDek,
    },
    {
      fetchImpl: deps.fetchImpl,
      logger: deps.logger,
      heartbeatIntervalMs: deps.heartbeatIntervalMs,
      ioFactory: (url, opts) => {
        capturedSocket = deps.ioFactory(url, opts);
        return capturedSocket;
      },
    },
  );

  const started = await startMachineClient(machineDeps);
  if (!started.ok) {
    deps.logger.warn("[machine-integration] failed to register/resume machine", {
      reason: started.reason,
    });
    return null;
  }
  const machineId = started.handle.identity.machineId;

  // Persist the (possibly freshly-minted) wrapped DEK so the NEXT boot
  // recovers this exact same one above, instead of minting a mismatched
  // fresh one — mirrors `machineClient.ts`'s own `persistMachineId` merge
  // (read-modify-write, no-op if the file is missing or already current).
  const stateAfterRegister = await readDaemonState(deps.homeDir);
  if (stateAfterRegister && stateAfterRegister.wrappedDek !== wrappedDek) {
    await writeDaemonState(deps.homeDir, { ...stateAfterRegister, wrappedDek });
  }

  if (!capturedSocket) {
    // Unreachable in practice — `startMachineClient` always calls `ioFactory`
    // exactly once before returning `ok: true` — but fail loudly rather than
    // silently skipping RPC registration if that ever stops being true.
    deps.logger.error(
      "[machine-integration] machine client connected but no socket was captured; RPC handlers were not registered",
    );
    return { machineId, stop: started.handle.stop };
  }

  // Fire-and-forget setup-script kickoff — binds `setupScript.ts`'s real runner
  // to this boot's `homeDir`/`logger`, matching every other homeDir-scoped
  // handler in this module. `spawnEngine.ts` already guarantees this is
  // only ever called on a genuine fresh-worktree creation and never awaits
  // it — see that module's own doc comment for the "never throws" contract
  // `setupScript.ts`'s `runSetupScript` upholds on its own.
  function runSetupScriptHandler(workspaceRoot: string, spawnDirectory: string): void {
    void runSetupScript(
      { workspaceRoot, directory: spawnDirectory },
      { homeDir: deps.homeDir, logger: deps.logger },
    );
  }

  // Guards against orphaned active session rows when the process dies after
  // DB-row creation, on an otherwise-healthy machine: subscribes to the SAME
  // `watchExit` `spawnAwaiter`
  // already used to resolve the spawn, but for the rest of this
  // process's life — not just the initial `/session-started` wait. If the
  // process later dies without the session's own clean `POST
  // /v1/sessions/:id/status` report ever landing (e.g. `runRemoteLoop()`'s
  // ACP connection setup throws instead of returning a reportable exit
  // code — `start.ts`'s `reportStatusOnce` is only ever reached from a
  // *returned* exit code or a caught signal, never from an uncaught throw),
  // the daemon itself files a best-effort `failed` report so the row
  // doesn't sit `active` forever on an otherwise-healthy machine.
  //
  // Deliberately best-effort and imprecise, made SAFE by a server-side
  // guard rather than by being precise here (`sessionStatus.ts`'s `failed`
  // transition now requires the session to still be `active` — see that
  // route's own doc comment): a redundant/late report for a session that
  // already cleanly reported `ended` or `failed` itself is a genuine no-op,
  // not a downgrade, so this never needs to determine "did the CLI already
  // report?" — it only needs to try, and let the server decide whether the
  // report was still needed. Skips the one genuinely unambiguous case (a
  // plain `code === 0, signal === null` exit) purely to cut noise — every
  // other exit shape (nonzero code, an uncaught signal like SIGKILL, or the
  // tmux-mode poll watcher's inherently-imprecise "gone" with both fields
  // `null`) still fires.
  function watchForUnreportedDeath(sessionId: string, watchExit: ProcessExitWatcher): void {
    watchExit((info) => {
      if (info.code === 0 && info.signal === null) return;
      void (async () => {
        const accessToken = await tokenProvider.getAccessToken();
        if (!accessToken) {
          deps.logger.debug(
            "[machine-integration] watchForUnreportedDeath: no access token available, skipping",
            { sessionId },
          );
          return;
        }
        const result = await reportSessionStatus(
          {
            backendUrl: deps.serverUrl,
            accessToken,
            fetchImpl: deps.fetchImpl,
            logger: deps.logger,
          },
          {
            sessionId,
            status: "failed",
            error: new Error(
              `daemon observed the spawned process exit (code ${info.code ?? "unknown"}${
                info.signal ? `, signal ${info.signal}` : ""
              }) without a clean self-report`,
            ),
          },
        );
        deps.logger.debug("[machine-integration] watchForUnreportedDeath: reported", {
          sessionId,
          result,
        });
      })();
    });
  }

  async function spawnSessionHandler(params: SpawnParams): Promise<SpawnResult> {
    return spawnSessionCore(params, {
      resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
      awaiter: deps.awaiter,
      logger: deps.logger,
      // the registry handle is already in scope here (same one
      // `resumeSessionHandler` below uses) — scan its live sessions for a
      // directory match before spawning, and record this spawn's own
      // directory once launched so a LATER spawn's scan can find it.
      findLiveSessionInDirectory: (realDirectory) =>
        scanForLiveSessionInDirectory(deps.registry.getSessions(), realDirectory),
      trackSpawned: deps.registry.trackSpawned,
      runSetupScript: runSetupScriptHandler,
      onSessionTracked: watchForUnreportedDeath,
      ...deps.spawnEngineOverrides,
    });
  }

  // `adopt.take`'s continuation spawn deliberately re-launches into a
  // directory that a tracked session ALREADY occupies — by definition, an
  // adopted provider session's directory is one Claude Code was already
  // running in (`adoptTake.ts`'s own doc comment), and a `mode: 'takeover'`
  // kill doesn't remove the old pid from the registry's live map until the
  // next `pruneDeadSessions` sweep (`sessionRegistry.ts`'s documented
  // `stopSession` behavior). `adopt.take` intentionally omits
  // `findLiveSessionInDirectory` — the dedup guard is for duplicate new-session
  // RPCs, not for continuation spawns. It still calls `trackSpawned` so a
  // later genuinely-new spawn's dedup scan can find this continuation session.
  async function spawnSessionForAdoptTake(params: SpawnParams): Promise<SpawnResult> {
    return spawnSessionCore(params, {
      resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
      awaiter: deps.awaiter,
      logger: deps.logger,
      trackSpawned: deps.registry.trackSpawned,
      runSetupScript: runSetupScriptHandler,
      onSessionTracked: watchForUnreportedDeath,
      ...deps.spawnEngineOverrides,
    });
  }

  async function resumeSessionHandler(sessionId: string): Promise<unknown> {
    return resumeSessionCore(sessionId, {
      registry: deps.registry,
      awaiter: deps.awaiter,
      resolveDirectory: deps.resolveResumeDirectory,
      logger: deps.logger,
      ...deps.resumeSessionOverrides,
    });
  }

  const adoptTakeDeps = createAdoptTakeDeps(
    { resolveProviderSession: deps.resolveProviderSession, spawnSession: spawnSessionForAdoptTake },
    { logger: deps.logger },
  );

  async function adoptTakeHandler(params: AdoptTakeParams): Promise<AdoptTakeResult> {
    return handleAdoptTake(params, adoptTakeDeps);
  }

  // Blob-storage fallback for `git.diff`/`adopt.mirror`'s `blobRef` fields.
  // Best-effort: a network hiccup costs the efficiency win, not the RPC itself.
  const blobKey = deriveBlobKey(dek);
  const blobClientDeps = createBlobClientDeps(
    { getAccessToken: () => tokenProvider.getAccessToken() },
    { serverUrl: deps.serverUrl, fetchImpl: deps.fetchImpl, logger: deps.logger },
  );
  async function uploadBlobHandler(plaintext: Uint8Array): Promise<string | null> {
    return uploadBlobToServer(plaintext, blobKey, blobClientDeps);
  }

  async function getGitDiffHandler(params: GitDiffParams): Promise<GitDiffResult> {
    return getGitDiff(params, { uploadBlob: uploadBlobHandler });
  }

  async function adoptMirrorHandler(params: AdoptMirrorParams): Promise<AdoptMirrorResult> {
    return handleAdoptMirror(params, {
      resolveProviderSession: deps.resolveProviderSession,
      logger: deps.logger,
      uploadBlob: uploadBlobHandler,
    });
  }

  // Live dev-server preview via secure tunnel: one in-memory tunnel
  // registry per daemon process, constructed here (the
  // composition root) since `preview.open`/`preview.close`/`preview.tunnels`
  // all need to share it — `machineRpc.ts` has no registry of its own to
  // default to, same reasoning as `adopt.take`'s shared state above.
  const previewTunnelDeps = createPreviewTunnelDeps({
    homeDir: deps.homeDir,
    registry: createTunnelRegistry(),
  });

  async function previewPortsHandler(params: PreviewPortsParams): Promise<PreviewPortsResult> {
    return handlePreviewPorts(params, previewTunnelDeps);
  }
  async function previewTunnelsHandler(
    params: PreviewTunnelsParams,
  ): Promise<PreviewTunnelsResult> {
    return handlePreviewTunnels(params, previewTunnelDeps);
  }
  async function previewOpenHandler(params: PreviewOpenParams): Promise<PreviewOpenResult> {
    return handlePreviewOpen(params, previewTunnelDeps);
  }
  async function previewCloseHandler(params: PreviewCloseParams): Promise<PreviewCloseResult> {
    return handlePreviewClose(params, previewTunnelDeps);
  }

  // The Setup/Run scripts subsystem's five RPCs each need `homeDir` — for
  // `runStateStore.ts`/the log files under `~/.kvy/logs/` — the same
  // reason `getGitDiffHandler`'s `uploadBlob` binding above exists: the
  // dependency only exists at this composition root, not inside
  // `runProcess.ts`/`workspaceConfigRpc.ts` themselves.
  async function getWorkspaceConfigHandler(
    params: WorkspaceGetConfigParams,
  ): Promise<WorkspaceGetConfigResult> {
    return handleWorkspaceGetConfig(params, { homeDir: deps.homeDir, logger: deps.logger });
  }
  async function runStartHandler(params: RunStartParams): Promise<RunStartResult> {
    return handleRunStart(params, { homeDir: deps.homeDir, logger: deps.logger });
  }
  async function runStopHandler(params: RunStopParams): Promise<RunStopResult> {
    return handleRunStop(params, { homeDir: deps.homeDir, logger: deps.logger });
  }
  async function runStatusHandler(params: RunStatusParams): Promise<RunStatusResult> {
    return handleRunStatus(params, { homeDir: deps.homeDir, logger: deps.logger });
  }
  async function runSetupHandler(params: RunSetupParams): Promise<RunSetupResult> {
    return handleRunSetup(params, { homeDir: deps.homeDir, logger: deps.logger });
  }

  const rpcHandle = registerMachineRpcHandlers({
    machineId,
    dek,
    socket: capturedSocket,
    spawnSession: spawnSessionHandler,
    resumeSession: resumeSessionHandler,
    adoptTake: adoptTakeHandler,
    adoptMirror: adoptMirrorHandler,
    getGitDiff: getGitDiffHandler,
    previewPorts: previewPortsHandler,
    previewTunnels: previewTunnelsHandler,
    previewOpen: previewOpenHandler,
    previewClose: previewCloseHandler,
    getSleepInhibit: deps.getSleepInhibit,
    setSleepInhibit: deps.setSleepInhibit,
    getWorkspaceConfig: getWorkspaceConfigHandler,
    runStart: runStartHandler,
    runStop: runStopHandler,
    runStatus: runStatusHandler,
    runSetup: runSetupHandler,
    logger: deps.logger,
  });

  deps.logger.info("[machine-integration] machine client + RPC handlers ready", { machineId });

  // Boot-time orphan reaping: a prior
  // daemon process that crashed/was SIGKILLed may have left `cloudflared`
  // children running with no kvy argv marker `kill.ts`/`markers.ts` could
  // ever find — `tunnels.json`'s pid journal is the only trail back to
  // them. Runs once per boot, before this daemon can itself start tracking
  // new tunnels.
  await reapOrphanedTunnels(deps.homeDir).catch((error: unknown) => {
    deps.logger.warn("[machine-integration] reapOrphanedTunnels failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // workspace's transcript dir for plain (non-Kvy) provider sessions.
  // Reuses this same boot's credentials/DEK to upsert against
  // `POST /v1/unmanaged-sessions` — a fresh per-row DEK per upsert
  // (`unmanagedSessionClient.ts`'s own contract), unrelated to `dek` above.
  const unmanagedSessionDeps = createUnmanagedSessionClientDeps(
    {
      getAccessToken: () => tokenProvider.getAccessToken(),
      contentPublicKey: keyTree.content.publicKey,
    },
    { serverUrl: deps.serverUrl, fetchImpl: deps.fetchImpl, logger: deps.logger },
  );
  // `params.workspaceId` here is really the local registry's real path
  // (`RegisteredWorkspace.workspaceId === .path`, `workspace/adapters.ts`'s
  // own doc comment) — resolve it to the opaque `workspaces.id` the server
  // actually stores before upserting, same as `start.ts`/`startCodex.ts`.
  // Cached per real path for this daemon's lifetime once resolution actually
  // succeeds: the transcript watch loop re-upserts on every debounced
  // change, and a path's opaque id never changes for the life of an
  // account/key-epoch. A `null` (transient network/auth failure —
  // `resolveServerWorkspaceId` already swallows and logs the real error) is
  // deliberately NOT cached, so the next debounced tick retries instead of
  // silently dropping every future upsert for this path for the daemon's
  // entire lifetime. The in-flight promise is still cached (not just the
  // resolved value) so concurrent calls for the same path dedupe onto one
  // request rather than firing a thundering herd.
  const opaqueWorkspaceIdCache = new Map<string, Promise<string | null>>();
  function resolveOpaqueWorkspaceId(realPath: string): Promise<string | null> {
    const cached = opaqueWorkspaceIdCache.get(realPath);
    if (cached) return cached;
    const resolved = resolveServerWorkspaceId(realPath, {
      serverUrl: deps.serverUrl,
      fetchImpl: deps.fetchImpl,
      getAuthToken: async () => (await tokenProvider.getAccessToken()) ?? "",
      contentPublicKey: keyTree.content.publicKey,
      workspaceIndexKey: keyTree.workspaceIndexKey,
      logger: deps.logger,
    }).then((id) => {
      if (id === null) opaqueWorkspaceIdCache.delete(realPath);
      return id;
    });
    opaqueWorkspaceIdCache.set(realPath, resolved);
    return resolved;
  }
  const transcriptIndexerHandle: TranscriptIndexerHandle = startTranscriptIndexer(
    createTranscriptIndexerDeps(
      {
        machineId,
        listWorkspaces: deps.listWorkspaces,
        upsert: async (params) => {
          const opaqueWorkspaceId = await resolveOpaqueWorkspaceId(params.workspaceId);
          if (!opaqueWorkspaceId) return false;
          return upsertUnmanagedSession(unmanagedSessionDeps, {
            ...params,
            workspaceId: opaqueWorkspaceId,
          });
        },
      },
      {
        logger: deps.logger,
        // Real lineage lookup (module header's "isManaged" seam, previously
        // left at the permanent "nothing is managed yet" default): a
        // transcript whose provider session id this daemon already tracks —
        // live or durably persisted — is this session's OWN backing file,
        // not an independent unmanaged one, and must never be dup-listed.
        isManaged: (providerRef) => deps.registry.isProviderSessionManaged(providerRef),
      },
    ),
  );

  return {
    machineId,
    stop: async () => {
      transcriptIndexerHandle.stop();
      rpcHandle.stop();
      // Close every tracked tunnel (SIGTERM->SIGKILL escalation per tunnel,
      // `previewTunnel.ts`'s `handlePreviewClose`) so a daemon stop/restart
      // never leaves a public `cloudflared` quick tunnel dangling.
      await closeAllTunnels(previewTunnelDeps);
      started.handle.stop();
    },
  };
}
