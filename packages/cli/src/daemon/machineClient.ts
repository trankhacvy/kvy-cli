/**
 * Machine-scoped WS client for the Falcon daemon.
 *
 * Ported, with changes, from Happy's `ApiMachineClient`
 * (happy-cli/src/api/apiMachine.ts, MIT) per plan.md §1.5 / design §7.1, §8:
 *
 *  - **Registration/CAS is HTTP, not WS.** Happy's client drives two
 *    separate WS acks (`machine-update-metadata`/`machine-update-state`)
 *    with a generic backoff-retry. Falcon's write path is HTTP-only end to
 *    end (design DELTA D1) — both fields are CAS'd together in one
 *    already-merged route, `POST /v1/machines`
 *    (`packages/server/src/app/routes/machines.ts`), and the retry is a
 *    bounded read-current-then-retry loop (design §4.3: "handle the 409
 *    `{current}` conflict by re-reading and retrying (x3)"), not unbounded
 *    exponential backoff. The `/v1/stream` socket (`clientType:
 *    "machine-scoped"`) is therefore just the heartbeat + (later) RPC
 *    transport from this client's perspective.
 *  - **`machineId` persists via `daemon.state.json`** (`state.ts`), not a
 *    separate settings file — a restarted daemon resumes the same
 *    server-side machine row by reading the id back out of that file
 *    instead of registering a new one on every boot.
 *  - **Heartbeat is every 60s** (design §8), not Happy's 20s, and this
 *    module does not track CLI-availability deltas — out of scope here.
 *  - **RPC handler registration** (spawnSession/stopSession/resumeSession/
 *    ...) is a separate, later plan bullet; this module only owns the
 *    connection lifecycle + registration + heartbeat + CAS sync.
 */

import { homedir, hostname, platform } from "node:os";
import { encodeBase64, encrypt } from "@falcon/crypto";
import type { EncryptedBox, MachineRow } from "@falcon/wire";
import { io as ioClientDefault, type Socket } from "socket.io-client";
import type { Logger } from "../logger.js";
import { readDaemonState, writeDaemonState } from "./state.js";

/** Plaintext machine facts, encrypted client-side before every `POST /v1/machines`. */
export interface MachineMetadata {
  host: string;
  platform: NodeJS.Platform;
  homeDir: string;
  cliVersion: string;
}

/** Plaintext daemon runtime facts — the encrypted, CAS-versioned `daemonState` field. */
export interface MachineRuntimeState {
  status: "running" | "stopped";
  pid: number;
  controlPort: number;
  startedAt: number;
}

export type EncryptionVariant = "legacy" | "dataKey";

export interface MachineFieldSnapshot<T> {
  value: T;
  version: number;
}

/** The client's decrypted view of a registered machine row. */
export interface MachineIdentity {
  machineId: string;
  metadata: MachineFieldSnapshot<MachineMetadata>;
  daemonState: MachineFieldSnapshot<MachineRuntimeState> | null;
}

export interface MachineClientDeps {
  serverUrl: string;
  token: string;
  homeDir: string;
  encryptionKey: Uint8Array;
  encryptionVariant: EncryptionVariant;
  /** Wrapped DEK (base64) — required only the first time a machine is registered. */
  dek: string;
  buildMetadata: () => MachineMetadata;
  buildRuntimeState: () => MachineRuntimeState;
  /** Injectable so unit tests never make a real network call. */
  fetchImpl: typeof fetch;
  /** Injectable so unit/integration tests can swap in a fake or a real-but-local socket.io-client. */
  ioFactory: (url: string, opts: Record<string, unknown>) => Socket;
  logger: Logger;
  now: () => number;
  heartbeatIntervalMs: number;
  /** Max `POST /v1/machines` attempts for a single CAS update (design §4.3: "retrying (x3)"). */
  maxCasRetries: number;
}

function defaultMetadata(): MachineMetadata {
  return {
    host: hostname(),
    platform: platform(),
    homeDir: homedir(),
    cliVersion: "0.1.0",
  };
}

export function createMachineClientDeps(
  required: Pick<
    MachineClientDeps,
    "serverUrl" | "token" | "homeDir" | "encryptionKey" | "encryptionVariant" | "dek"
  >,
  overrides: Partial<MachineClientDeps> = {},
): MachineClientDeps {
  return {
    buildMetadata: defaultMetadata,
    buildRuntimeState: () => ({
      status: "running",
      pid: process.pid,
      controlPort: 0,
      startedAt: Date.now(),
    }),
    fetchImpl: fetch,
    ioFactory: (url, opts) => ioClientDefault(url, opts),
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => Date.now(),
    heartbeatIntervalMs: 60_000,
    maxCasRetries: 3,
    ...required,
    ...overrides,
  };
}

function box(
  deps: Pick<MachineClientDeps, "encryptionKey" | "encryptionVariant">,
  data: unknown,
): EncryptedBox {
  const cipher = encrypt(deps.encryptionKey, deps.encryptionVariant, data);
  return { t: "enc", v: 1, c: encodeBase64(cipher) };
}

type MachinePostResult =
  | { status: "created" | "updated"; row: MachineRow }
  | { status: "not-found" }
  | {
      status: "conflict";
      current: {
        metadata: MachineFieldSnapshot<EncryptedBox>;
        daemonState: MachineFieldSnapshot<EncryptedBox> | null;
      };
    }
  | { status: "error"; detail: string };

async function postMachines(
  deps: MachineClientDeps,
  body: {
    machineId?: string;
    dek?: string;
    metadata: { value: EncryptedBox; expectedVersion: number };
    daemonState?: { value: EncryptedBox; expectedVersion: number };
  },
): Promise<MachinePostResult> {
  try {
    const res = await deps.fetchImpl(`${deps.serverUrl}/v1/machines`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.token}`,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 201) return { status: "created", row: (await res.json()) as MachineRow };
    if (res.status === 200) return { status: "updated", row: (await res.json()) as MachineRow };
    if (res.status === 404) return { status: "not-found" };
    if (res.status === 409) {
      const payload = (await res.json()) as {
        current: {
          metadata: MachineFieldSnapshot<EncryptedBox>;
          daemonState: MachineFieldSnapshot<EncryptedBox> | null;
        };
      };
      return { status: "conflict", current: payload.current };
    }
    return { status: "error", detail: `unexpected HTTP ${res.status}` };
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

function toIdentity(
  row: MachineRow,
  metadata: MachineMetadata,
  daemonState: MachineRuntimeState,
): MachineIdentity {
  return {
    machineId: row.id,
    metadata: { value: metadata, version: row.metadata.version },
    daemonState: row.daemonState ? { value: daemonState, version: row.daemonState.version } : null,
  };
}

export type RegisterMachineResult =
  | { ok: true; identity: MachineIdentity }
  | { ok: false; reason: string };

/**
 * CAS-update an already-registered machine, retrying on `409 {current}` by
 * re-reading the server's current version and resubmitting — up to
 * `deps.maxCasRetries` attempts total (design §4.3). Both `metadata` and
 * `daemonState` travel in every call (the route's `metadata` field is
 * mandatory even when only `daemonState` actually changed), so a 409 on
 * either field is retried with both re-read.
 */
async function casUpdateMachine(
  deps: MachineClientDeps,
  params: {
    machineId: string;
    metadata: MachineMetadata;
    metadataVersion: number;
    daemonState: MachineRuntimeState;
    daemonStateVersion: number;
  },
): Promise<RegisterMachineResult> {
  let { metadataVersion, daemonStateVersion } = params;

  for (let attempt = 1; attempt <= deps.maxCasRetries; attempt++) {
    const result = await postMachines(deps, {
      machineId: params.machineId,
      metadata: { value: box(deps, params.metadata), expectedVersion: metadataVersion },
      daemonState: { value: box(deps, params.daemonState), expectedVersion: daemonStateVersion },
    });

    switch (result.status) {
      case "created":
      case "updated":
        return { ok: true, identity: toIdentity(result.row, params.metadata, params.daemonState) };
      case "not-found":
        return { ok: false, reason: "not-found" };
      case "conflict":
        metadataVersion = result.current.metadata.version;
        daemonStateVersion = result.current.daemonState?.version ?? 0;
        deps.logger.debug("[machine-client] CAS conflict, retrying", {
          attempt,
          metadataVersion,
          daemonStateVersion,
        });
        continue;
      case "error":
        return { ok: false, reason: result.detail };
    }
  }

  return { ok: false, reason: `exhausted ${deps.maxCasRetries} CAS retries` };
}

/**
 * Registers a brand new machine (no locally-remembered `machineId`) or
 * resumes an existing one, retrying CAS conflicts per `casUpdateMachine`.
 * A resume that comes back `404 not-found` (the remembered id was
 * re-associated to a different account, or the row is otherwise gone) falls
 * back to a fresh registration rather than failing outright — mirrors
 * Happy's re-auth-conflict handling in `api.ts`.
 */
export async function registerOrResumeMachine(
  deps: MachineClientDeps,
  existingMachineId: string | null,
): Promise<RegisterMachineResult> {
  const metadata = deps.buildMetadata();
  const daemonState = deps.buildRuntimeState();

  if (!existingMachineId) {
    const result = await postMachines(deps, {
      dek: deps.dek,
      metadata: { value: box(deps, metadata), expectedVersion: 0 },
      daemonState: { value: box(deps, daemonState), expectedVersion: 0 },
    });
    if (result.status === "created" || result.status === "updated") {
      return { ok: true, identity: toIdentity(result.row, metadata, daemonState) };
    }
    return {
      ok: false,
      reason:
        result.status === "error"
          ? result.detail
          : `unexpected ${result.status} registering a new machine`,
    };
  }

  const resumed = await casUpdateMachine(deps, {
    machineId: existingMachineId,
    metadata,
    metadataVersion: 0,
    daemonState,
    daemonStateVersion: 0,
  });

  if (!resumed.ok && resumed.reason === "not-found") {
    deps.logger.warn("[machine-client] remembered machineId not found, registering fresh", {
      machineId: existingMachineId,
    });
    return registerOrResumeMachine(deps, null);
  }

  return resumed;
}

/** Pushes a fresh `daemonState` (e.g. on (re)connect) via the same CAS-retry path. */
export function pushRuntimeState(
  deps: MachineClientDeps,
  identity: MachineIdentity,
  daemonState: MachineRuntimeState,
): Promise<RegisterMachineResult> {
  return casUpdateMachine(deps, {
    machineId: identity.machineId,
    metadata: identity.metadata.value,
    metadataVersion: identity.metadata.version,
    daemonState,
    daemonStateVersion: identity.daemonState?.version ?? 0,
  });
}

/**
 * Merges `machineId` into `daemon.state.json` so a restarted daemon resumes
 * this machine row instead of registering a new one. A no-op if the file
 * doesn't exist yet (nothing to merge into — matches `state.ts`'s "dumb,
 * no locking" contract) or already names this id.
 */
export async function persistMachineId(homeDir: string, machineId: string): Promise<void> {
  const existing = await readDaemonState(homeDir);
  if (!existing || existing.machineId === machineId) return;
  await writeDaemonState(homeDir, { ...existing, machineId });
}

export interface MachineClientHandle {
  readonly identity: MachineIdentity;
  stop: () => void;
}

export type StartMachineClientResult =
  | { ok: true; handle: MachineClientHandle }
  | { ok: false; reason: string };

/**
 * Registers/resumes the machine, opens the `/v1/stream` socket
 * (`clientType: "machine-scoped"`), and starts the 60s heartbeat. Every
 * (re)connect re-pushes `daemonState` via CAS against the same
 * `machineId` — never a fresh insert — so a dropped-and-restored
 * connection cannot duplicate the machine row.
 */
export async function startMachineClient(
  deps: MachineClientDeps,
): Promise<StartMachineClientResult> {
  const existingState = await readDaemonState(deps.homeDir);
  const registered = await registerOrResumeMachine(deps, existingState?.machineId ?? null);
  if (!registered.ok) {
    deps.logger.error("[machine-client] failed to register/resume machine", {
      reason: registered.reason,
    });
    return { ok: false, reason: registered.reason };
  }

  let identity = registered.identity;
  await persistMachineId(deps.homeDir, identity.machineId);

  const socket = deps.ioFactory(deps.serverUrl, {
    path: "/v1/stream",
    transports: ["websocket"],
    auth: { token: deps.token, clientType: "machine-scoped", machineId: identity.machineId },
  });

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function sendHeartbeat(): void {
    socket.emit("machine-alive", { machineId: identity.machineId, time: deps.now() });
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, deps.heartbeatIntervalMs);
  }

  socket.on("connect", () => {
    if (stopped) return;
    deps.logger.info("[machine-client] connected", { machineId: identity.machineId });
    startHeartbeat();

    pushRuntimeState(deps, identity, deps.buildRuntimeState())
      .then((result) => {
        if (result.ok) {
          identity = result.identity;
        } else {
          deps.logger.warn("[machine-client] failed to push daemonState on connect", {
            reason: result.reason,
          });
        }
      })
      .catch((error: unknown) => {
        deps.logger.warn("[machine-client] daemonState push threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  socket.on("disconnect", (reason: string) => {
    deps.logger.info("[machine-client] disconnected", { reason });
    stopHeartbeat();

    // socket.io-client auto-reconnects on transport drops, but NOT when the
    // server explicitly disconnects the socket (`reason === "io server
    // disconnect"`) — that case requires an explicit `connect()` per the
    // client's own docs. This is a persistent connection (design §8), so it
    // must always keep trying regardless of why it went down, unless we're
    // the one shutting it down (`stopped`).
    if (!stopped) socket.connect();
  });

  return {
    ok: true,
    handle: {
      get identity() {
        return identity;
      },
      stop: () => {
        stopped = true;
        stopHeartbeat();
        socket.close();
      },
    },
  };
}
