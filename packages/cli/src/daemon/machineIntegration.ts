/**
 * Wires `machineClient.ts` + `machineRpc.ts` (both already built, unit- and
 * integration-tested, and — until now — never called from a live daemon
 * process) into `commands.ts`'s `runDaemonStartSync` boot sequence (plan.md
 * §16 "1.5"/"3.1"/"3.2"/"3.3" — daemon integration).
 *
 * This module owns exactly the glue: deriving the account's content keypair
 * from the locally-stored credentials (design §5.1), minting/wrapping this
 * machine's DEK, opening the machine-scoped `/v1/stream` socket
 * (`startMachineClient`), and binding `registerMachineRpcHandlers`'s
 * `spawnSession`/`resumeSession`/`adoptTake`/`adoptMirror` callbacks to the
 * real `spawnEngine.ts`/`resumeSession.ts`/`adoptTake.ts`/
 * `transcriptMirror.ts` implementations — replacing `commands.ts`'s old
 * literal "not implemented yet" stub. `git.status`/`fs.list`/`fs.mkdir`/
 * `workspace.register` (plan.md §16 "Flow 3 — spawn-fresh-folder-register
 * (Piece A)") need no extra wiring here: `registerMachineRpcHandlers`
 * already has real, dependency-free defaults for all four —
 * `workspace.register`'s default (`workspaceRegisterRpc.ts`) wraps the same
 * `workspace/registry.ts` store `resolveWorkspaceRoot` below is backed by.
 * `git.diff`/`adopt.mirror` DO get
 * extra wiring — a `deps.uploadBlob` closure (`blobClient.ts`'s
 * `uploadBlob`, bound to this machine's server credentials and a
 * `deriveBlobKey(dek)`-derived blob key, design §5.1) is threaded into
 * both, so a diff/transcript too large for the 64KB RPC control-plane
 * budget gets a real `blobRef` instead of just a truncated inline preview
 * (plan.md §16 "4.3 Distribution & self-host" — the blob-storage subsystem
 * both handlers' own doc comments reserved this field for).
 *
 * **No stored credentials ⇒ no machine client.** A daemon with nobody
 * logged in yet (`falcon auth login` never run) has no token/masterSecret
 * to register a machine or open an authenticated socket with — this is
 * normal, not an error (design's local-first posture: `falcon claude` works
 * fully offline). `startMachineIntegration` returns `null` in that case,
 * logged at `info`, and the daemon keeps running local-only (control
 * server, session registry, self-update heartbeat all still work — none of
 * those depend on a server connection).
 *
 * **Socket capture.** `startMachineClient` owns the socket's lifecycle
 * end-to-end (connect/reconnect/heartbeat) but doesn't hand it back to the
 * caller — `MachineClientHandle` only exposes `identity`/`stop`. Since
 * `registerMachineRpcHandlers` needs the *same* socket instance to answer
 * `rpc-request`s, this module wraps the injected `ioFactory` to capture the
 * socket `startMachineClient` creates internally, rather than modifying
 * `machineClient.ts`'s own public surface for a single caller's need.
 *
 * **DEK survives restarts.** `POST /v1/machines`'s CAS-update path (a
 * resumed `machineId`) never re-sends or rotates `dek` — the server keeps
 * whatever was stored at first registration forever (`machines.ts`'s own
 * doc comment). So this module persists its wrapped DEK into
 * `daemon.state.json` (`state.ts`'s `wrappedDek`, alongside `machineId`)
 * and unwraps it back on every later boot instead of minting a fresh one —
 * otherwise a restarted daemon would silently start encrypting/decrypting
 * every machine RPC under a key that no longer matches what the server (and
 * any other real client unwrapping the same row) actually uses.
 *
 * **Workspace registry is caller-injected, not invented here.** `spawn`'s
 * `resolveWorkspaceRoot` and the transcript indexer's `listWorkspaces` are
 * the same injected seams `spawnEngine.ts`/`workspacePath.ts`/
 * `transcriptIndexer.ts` already document — this module still does not
 * hard-code a specific registry implementation, it just wires whatever
 * `deps` supplies into `spawnSession`/`startTranscriptIndexer`.
 * `daemon/commands.ts` is the composition root that now supplies the real
 * `~/.falcon/workspaces.json`-backed registry (`workspace/adapters.ts`) as
 * both of these defaults; `createMachineIntegrationDeps` here still
 * defaults to the honest "nothing registered" stand-in so this module's own
 * unit tests never depend on that store.
 *
 * `adopt.take`/`adopt.mirror`'s `resolveProviderSession` remains a
 * no-real-default seam (`providerSessionResolver.ts`'s own doc comment) —
 * resolving a bare provider session id needs transcript-content scanning,
 * a different, later composition than "which directories are registered".
 *
 * **Transcript indexer starts here too.** Once the machine RPC handlers are
 * registered, this module also starts the adoption Tier-1 transcript
 * indexer (`transcriptIndexer.ts`) against the same `machineId` and
 * `deps.listWorkspaces`, upserting via a fresh `unmanagedSessionClient.ts`
 * client built from this boot's credentials/DEK — mirroring the RPC
 * handlers' own "reachable but previously never started" gap: the module
 * existed, fully tested, with nothing calling `startTranscriptIndexer` from
 * a live daemon boot until now.
 */
import {
  decodeBase64,
  deriveBlobKey,
  deriveKeyTree,
  encodeBase64,
  getRandomBytes,
  unwrapDek,
  wrapDek,
} from "@falcon/crypto";
import type {
  AdoptMirrorParams,
  AdoptMirrorResult,
  AdoptTakeParams,
  AdoptTakeResult,
  GitDiffParams,
  GitDiffResult,
  SpawnParams,
  SpawnResult,
} from "@falcon/wire";
import type { Socket } from "socket.io-client";
import type { FalconCredentials } from "../auth/credentials.js";
import type { Logger } from "../logger.js";
import { createAdoptTakeDeps, handleAdoptTake } from "./adoptTake.js";
import { createBlobClientDeps, uploadBlob as uploadBlobToServer } from "./blobClient.js";
import { getGitDiff } from "./gitDiff.js";
import { createMachineClientDeps, startMachineClient } from "./machineClient.js";
import { registerMachineRpcHandlers } from "./machineRpc.js";
import type { ProviderSessionResolver } from "./providerSessionResolver.js";
import {
  type ResumeSessionDeps,
  type ResumeSessionRegistry,
  resumeSession as resumeSessionCore,
} from "./resumeSession.js";
import type { PersistedSession } from "./sessionsStore.js";
import type { SpawnAwaiter } from "./spawnAwaiter.js";
import { type SpawnEngineDeps, spawnSession as spawnSessionCore } from "./spawnEngine.js";
import { readDaemonState, writeDaemonState } from "./state.js";
import {
  createTranscriptIndexerDeps,
  type RegisteredWorkspace,
  startTranscriptIndexer,
  type TranscriptIndexerHandle,
} from "./transcriptIndexer.js";
import { handleAdoptMirror } from "./transcriptMirror.js";
import {
  createUnmanagedSessionClientDeps,
  upsertUnmanagedSession,
} from "./unmanagedSessionClient.js";
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
  /** Reads `~/.falcon/access.key`; `null` means "not logged in" (local-only mode). */
  readCredentials: () => FalconCredentials | null;
  /** Resolves a `spawn` RPC's `workspaceId` to its registered root directory; `null` for anything unregistered (design §12: no arbitrary-directory execution from remote). Defaults to "nothing registered" here — `daemon/commands.ts` supplies the real registry. See module header. */
  resolveWorkspaceRoot: WorkspaceRootLookup;
  /** Lists every registered workspace, for the transcript indexer's boot-time (and periodic re-scan) fs-watch. Defaults to "nothing registered" here — `daemon/commands.ts` supplies the real registry. See module header. */
  listWorkspaces: () => Promise<RegisteredWorkspace[]>;
  /** Resolves `adopt.take`/`adopt.mirror`'s bare provider session id back to a registered workspace. No real default yet — see module header. */
  resolveProviderSession: ProviderSessionResolver;
  /** Resolves the working directory to relaunch a `resumeSession` RPC's target in, from its persisted record. No real default yet (matches `resumeSession.ts`'s own doc comment: honestly fail rather than guess). */
  resolveResumeDirectory: (
    session: PersistedSession,
  ) => string | null | undefined | Promise<string | null | undefined>;
  heartbeatIntervalMs: number;
  registry: ResumeSessionRegistry;
  awaiter: SpawnAwaiter;
  /** Test-only escape hatch: extra overrides merged into `spawnEngine.ts`'s deps (e.g. a fake process launcher). Production leaves this unset — `spawnEngine.ts`'s own real defaults (tmux/detached launch) apply. */
  spawnEngineOverrides?: Partial<SpawnEngineDeps>;
  /** Same, for `resumeSession.ts`. */
  resumeSessionOverrides?: Partial<ResumeSessionDeps>;
}

export interface MachineIntegrationHandle {
  readonly machineId: string;
  stop: () => void;
}

function defaultLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
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
    resolveResumeDirectory: () => undefined,
    heartbeatIntervalMs: 60_000,
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

  const masterSecret = decodeBase64(credentials.masterSecretOrContentBundle);
  if (masterSecret.length !== MASTER_SECRET_LENGTH_BYTES) {
    deps.logger.warn(
      "[machine-integration] stored credentials are not a full masterSecret (reduced-custody pairing?), skipping machine client",
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
      token: credentials.token,
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

  async function spawnSessionHandler(params: SpawnParams): Promise<SpawnResult> {
    return spawnSessionCore(params, {
      resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
      awaiter: deps.awaiter,
      logger: deps.logger,
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
    { resolveProviderSession: deps.resolveProviderSession, spawnSession: spawnSessionHandler },
    { logger: deps.logger },
  );

  async function adoptTakeHandler(params: AdoptTakeParams): Promise<AdoptTakeResult> {
    return handleAdoptTake(params, adoptTakeDeps);
  }

  // The blob-storage fallback (plan.md §16 "4.3 Distribution & self-host")
  // for `git.diff`/`adopt.mirror`'s reserved `blobRef` fields: this
  // machine's own DEK — already established above, already what every
  // other machine RPC's params/results are sealed under — derives a blob
  // key the same way any session's DEK would (design §5.1: `HKDF(DEK,
  // "falcon-blobs")`), and `uploadBlobToServer` is bound to this machine's
  // own server credentials. Best-effort by contract (never throws — see
  // `blobClient.ts`'s header comment), so a network hiccup here just costs
  // the blobRef efficiency win, not the RPC itself.
  const blobKey = deriveBlobKey(dek);
  const blobClientDeps = createBlobClientDeps(
    { token: credentials.token },
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

  const rpcHandle = registerMachineRpcHandlers({
    machineId,
    dek,
    socket: capturedSocket,
    spawnSession: spawnSessionHandler,
    resumeSession: resumeSessionHandler,
    adoptTake: adoptTakeHandler,
    adoptMirror: adoptMirrorHandler,
    getGitDiff: getGitDiffHandler,
    logger: deps.logger,
  });

  deps.logger.info("[machine-integration] machine client + RPC handlers ready", { machineId });

  // Adoption Tier 1 (design §8/§11 UC9): fs-watch every registered
  // workspace's transcript dir for plain (non-Falcon) provider sessions.
  // Reuses this same boot's credentials/DEK to upsert against
  // `POST /v1/unmanaged-sessions` — a fresh per-row DEK per upsert
  // (`unmanagedSessionClient.ts`'s own contract), unrelated to `dek` above.
  const unmanagedSessionDeps = createUnmanagedSessionClientDeps(
    { token: credentials.token, contentPublicKey: keyTree.content.publicKey },
    { serverUrl: deps.serverUrl, fetchImpl: deps.fetchImpl, logger: deps.logger },
  );
  const transcriptIndexerHandle: TranscriptIndexerHandle = startTranscriptIndexer(
    createTranscriptIndexerDeps(
      {
        machineId,
        listWorkspaces: deps.listWorkspaces,
        upsert: (params) => upsertUnmanagedSession(unmanagedSessionDeps, params),
      },
      { logger: deps.logger },
    ),
  );

  return {
    machineId,
    stop: () => {
      transcriptIndexerHandle.stop();
      rpcHandle.stop();
      started.handle.stop();
    },
  };
}
