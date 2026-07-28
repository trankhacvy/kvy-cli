/**
 * Boots the "real local stack" the conformance harness runs its 20 steps
 * against (design §13 item 3): a real `@falcon/server` (real Fastify app,
 * real Socket.IO, real in-memory Postgres via `@electric-sql/pglite`), a
 * real `falcon` daemon boot (`runDaemonStartSync` — real singleton lock,
 * real control server, real session registry, real machine-scoped RPC
 * handler wiring), and a real "controller" client socket standing in for
 * the web/mobile app.
 *
 * The one thing that ISN'T real is the provider CLI subprocess a `spawn`
 * RPC would normally launch — no sandbox here can run an actual Claude Code
 * session. In its place, `buildFakeLaunchProcess` mints a pid and, shortly
 * after (mirroring `commands.machineWiring.integration.test.ts`'s own
 * pattern), performs the exact two steps a real `falcon claude
 * --starting-mode remote` process performs on startup: `bootstrapSession`
 * against the real server (real session row, real minted DEK) and a
 * `FakeSessionProcess` registering the real session RPC handlers — then
 * self-reports via the real `notify.ts` client hitting the daemon's own
 * real control server `/session-started` webhook, exactly like the real
 * thing would.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type BoxKeyPair,
  deriveKeyTree,
  getRandomBytes,
  open,
  seal,
  unwrapDek,
} from "@falcon/crypto";
import type { EncryptedBox } from "@falcon/wire";
import { type Socket as ClientSocket, io as ioClientDefault } from "socket.io-client";
// Cross-package source imports — see fakeSessionProcess.ts's header comment
// for why (`falcon`/`@falcon/server` are private, unpublished packages with
// no subpath `exports` for their internals).
import { writeCredentials } from "../../packages/cli/src/auth/credentials.js";
import { plaintextFallbackKeyMaterial } from "../../packages/cli/src/auth/keyMaterial.js";
import {
  createDaemonCommandDeps,
  type DaemonCommandDeps,
  runDaemonStartSync,
} from "../../packages/cli/src/daemon/commands.js";
import {
  createNotifyDaemonSessionStartedDeps,
  notifyDaemonSessionStarted,
} from "../../packages/cli/src/daemon/notify.js";
import type {
  LaunchedProcess,
  LaunchProcessOptions,
} from "../../packages/cli/src/daemon/processLauncher.js";
import { readDaemonState } from "../../packages/cli/src/daemon/state.js";
import type { ProcessExitWatcher } from "../../packages/cli/src/daemon/types.js";
import type { Logger } from "../../packages/cli/src/logger.js";
import {
  bootstrapSession,
  createBootstrapSessionDeps,
} from "../../packages/cli/src/session/bootstrap.js";
import {
  createTestAccount,
  createTestDb,
} from "../../packages/server/src/app/routes/testHelpers.js";
import { buildServer } from "../../packages/server/src/app/server.js";
import { FakeSessionProcess } from "./fakeSessionProcess.js";

const execFileAsync = promisify(execFile);

export interface TrackedSession {
  dek: Uint8Array;
  process: FakeSessionProcess;
}

export interface TestStack {
  serverUrl: string;
  token: string;
  accountId: string;
  homeDir: string;
  workspaceDir: string;
  machineId: string;
  machineDek: Uint8Array;
  contentKeyPair: BoxKeyPair;
  controller: ClientSocket;
  /** Every `FakeSessionProcess` minted by a `spawn`/`adopt.take` this stack served, keyed by real sessionId. */
  sessions: Map<string, TrackedSession>;
  callMachineRpc<T>(method: string, params: unknown): Promise<T>;
  callSessionRpc<T>(sessionId: string, method: string, params: unknown): Promise<T>;
  fetchMessageBatches(sessionId: string): Promise<{ seq: number; content: EncryptedBox }[]>;
  logger: Logger;
  teardown(): Promise<void>;
}

function noopLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== null && result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error("testStack.waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The stand-in for `spawnEngine.ts`'s real `launchProviderProcess`: mints a
 * pid synchronously (so `spawnSession`'s `awaiter.waitFor(pid)` call — which
 * runs right after `launch()` resolves — registers its pending waiter
 * BEFORE the self-report below fires), then, shortly after, runs the real
 * bootstrap + session-process-registration + self-report sequence a real
 * spawned process would run on startup.
 */
function buildFakeLaunchProcess(deps: {
  serverUrl: string;
  token: string;
  homeDir: string;
  contentKeyPair: BoxKeyPair;
  sessions: Map<string, TrackedSession>;
  logger: Logger;
}): (opts: LaunchProcessOptions) => Promise<LaunchedProcess> {
  let nextPid = 900_000;
  let nonceCounter = 0;

  return async (opts: LaunchProcessOptions): Promise<LaunchedProcess> => {
    const pid = nextPid++;
    const nonce = `e2e-spawn-${++nonceCounter}`;

    setTimeout(() => {
      void (async () => {
        const outboxHomeDir = await mkdtemp(path.join(tmpdir(), "falcon-e2e-outbox-"));
        const boot = await bootstrapSession(
          createBootstrapSessionDeps({ serverUrl: deps.serverUrl, getAuthToken: () => deps.token }),
          {
            // Not FK-validated server-side (sessions.machineId is a bare
            // nullable text column) — any stable string is fine here; this
            // fake launch process doesn't know (and doesn't need) the real
            // daemon-registered machineId to mint a valid session row.
            machineId: "e2e-conformance-machine",
            workspacePath: opts.cwd,
            nonce,
            provider: "claude-code",
            contentKeyPair: deps.contentKeyPair,
            metadata: { title: "conformance session", path: opts.cwd },
          },
        );

        const process = await FakeSessionProcess.start({
          serverUrl: deps.serverUrl,
          token: deps.token,
          sessionId: boot.sessionId,
          dek: boot.dek,
          outboxHomeDir,
          logger: deps.logger,
        });
        deps.sessions.set(boot.sessionId, { dek: boot.dek, process });

        await notifyDaemonSessionStarted(
          createNotifyDaemonSessionStartedDeps({
            homeDir: deps.homeDir,
            fetchImpl: fetch,
            isProcessAlive: () => true,
          }),
          {
            sessionId: boot.sessionId,
            pid,
            metadata: { directory: opts.cwd },
            encryption: {
              encryptionKey: "e2e-placeholder",
              seq: 0,
              metadataVersion: 0,
              agentStateVersion: 0,
            },
          },
        );
      })();
    }, 20);

    // This `pid` is a synthetic counter (`nextPid++` above), never a real
    // process — there is nothing for a real exit watcher to observe, so a
    // permanent no-op is the honest implementation (mirrors `spawnAwaiter.ts`'s
    // own tolerance for an absent/no-op `watchExit`: it just means this fake
    // launch can never fast-fail via A3's exit-detection path, which is
    // correct here since it never actually exits).
    const watchExit: ProcessExitWatcher = () => () => {};

    return { method: "detached", pid, watchExit };
  };
}

export async function buildTestStack(): Promise<TestStack> {
  const logger = noopLogger();

  const { db, pglite } = await createTestDb();
  const app = await buildServer({ logger: false }, { db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  const serverUrl = `http://127.0.0.1:${address.port}`;

  const account = await createTestAccount(db);
  const token = account.token;
  const accountId = account.account.id;

  const homeDir = await mkdtemp(path.join(tmpdir(), "falcon-e2e-home-"));
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "falcon-e2e-workspace-"));
  await execFileAsync("git", ["init"], { cwd: workspaceDir });

  const masterSecret = getRandomBytes(32);
  writeCredentials(
    { refreshToken: account.refreshToken, keyMaterial: plaintextFallbackKeyMaterial(masterSecret) },
    homeDir,
  );
  const keyTree = deriveKeyTree(masterSecret);

  const sessions = new Map<string, TrackedSession>();
  const fakeLaunchProcess = buildFakeLaunchProcess({
    serverUrl,
    token,
    homeDir,
    contentKeyPair: keyTree.content,
    sessions,
    logger,
  });

  let triggerShutdown: (() => void) | undefined;
  const deps: DaemonCommandDeps = createDaemonCommandDeps({
    homeDir,
    logger,
    registerShutdownSignals: (onShutdown) => {
      triggerShutdown = onShutdown;
      return () => {};
    },
    isProcessAlive: () => true,
    machineServerUrl: serverUrl,
    resolveWorkspaceRoot: (workspaceId) => (workspaceId === "ws_1" ? workspaceDir : null),
    resolveProviderSession: async (providerSessionId) =>
      providerSessionId === "prov_1" ? { workspaceId: "ws_1", directory: workspaceDir } : null,
    resolveResumeDirectory: (session) =>
      (session.metadata as { directory?: string } | undefined)?.directory,
    spawnEngineOverrides: { launchProcess: fakeLaunchProcess },
    resumeSessionOverrides: { launchProcess: fakeLaunchProcess },
  });

  const bootPromise = runDaemonStartSync(deps);
  await waitFor(() => readDaemonState(homeDir));

  const machineRow = await waitFor(() =>
    db.query.machines.findFirst({ where: (m, { eq }) => eq(m.accountId, accountId) }),
  );
  const machineId = machineRow.id;
  const machineDek = unwrapDek(machineRow.dek, keyTree.content.secretKey);
  if (!machineDek)
    throw new Error("testStack: failed to unwrap the daemon's registered machine DEK");

  const controller: ClientSocket = ioClientDefault(serverUrl, {
    path: "/v1/stream",
    transports: ["websocket"],
    auth: { token },
  });
  await new Promise<void>((resolve, reject) => {
    controller.once("connect", () => resolve());
    controller.once("connect_error", (error: Error) => reject(error));
  });

  async function callRpc<T>(
    target: string,
    method: string,
    params: unknown,
    dek: Uint8Array,
  ): Promise<T> {
    const response = (await controller.timeout(20_000).emitWithAck("rpc-call", {
      target,
      method,
      params: seal(params, dek),
    })) as { ok: true; result: EncryptedBox } | { ok: false; error: string };

    if (!response.ok) {
      throw new Error(`rpc-call ${method} (${target}) failed: ${response.error}`);
    }
    const opened = open<T>(response.result, dek);
    if (opened === null)
      throw new Error(`rpc-call ${method} (${target}): failed to decrypt result`);
    return opened;
  }

  async function fetchMessageBatches(
    sessionId: string,
  ): Promise<{ seq: number; content: EncryptedBox }[]> {
    const all: { seq: number; content: EncryptedBox }[] = [];
    let before: number | undefined;
    for (;;) {
      const url = new URL(`${serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}/messages`);
      url.searchParams.set("limit", "200");
      if (before !== undefined) url.searchParams.set("before", String(before));
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`fetchMessageBatches: GET messages responded ${res.status}`);
      const body = (await res.json()) as {
        messages: { seq: number; content: EncryptedBox }[];
        nextBefore: number | null;
      };
      all.push(...body.messages);
      if (body.nextBefore === null) break;
      before = body.nextBefore;
    }
    return all.sort((a, b) => a.seq - b.seq);
  }

  return {
    serverUrl,
    token,
    accountId,
    homeDir,
    workspaceDir,
    machineId,
    machineDek,
    contentKeyPair: keyTree.content,
    controller,
    sessions,
    logger,
    callMachineRpc: (method, params) =>
      callRpc(`m:${machineId}:${method}`, method, params, machineDek),
    callSessionRpc: (sessionId, method, params) => {
      const tracked = sessions.get(sessionId);
      if (!tracked) throw new Error(`callSessionRpc: unknown sessionId "${sessionId}"`);
      return callRpc(`s:${sessionId}:${method}`, method, params, tracked.dek);
    },
    fetchMessageBatches,
    teardown: async () => {
      controller.close();
      for (const tracked of sessions.values()) tracked.process.dispose();
      if (triggerShutdown) {
        triggerShutdown();
        await bootPromise;
      }
      await app.close();
      await pglite.close();
      await rm(homeDir, { recursive: true, force: true });
      await rm(workspaceDir, { recursive: true, force: true });
    },
  };
}
