import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PGlite } from "@electric-sql/pglite";
import { deriveKeyTree, encodeBase64, getRandomBytes, open, seal, unwrapDek } from "@falcon/crypto";
import type { EncryptedBox } from "@falcon/wire";
import type { FastifyInstance } from "fastify";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
// Cross-package source import (test-only) — same convention as
// `session/bootstrap.integration.test.ts`: `@falcon/server` is a private,
// unpublished app package with no built subpath for its test utilities, so
// this reaches its TS source directly. Declared as a devDependency in
// package.json for workspace-graph clarity even though the import itself is
// a relative path, not the package name.
import { createTestAccount, createTestDb } from "../../../server/src/app/routes/testHelpers.js";
import { buildServer } from "../../../server/src/app/server.js";
import { writeCredentials } from "../auth/credentials.js";
import type { Logger } from "../logger.js";
import { readSettings } from "../persistence.js";
import { createDaemonCommandDeps, type DaemonCommandDeps, runDaemonStartSync } from "./commands.js";
import { createNotifyDaemonSessionStartedDeps, notifyDaemonSessionStarted } from "./notify.js";
import type { LaunchedProcess, LaunchProcessOptions } from "./processLauncher.js";
import { createSleepInhibitManager, type SleepInhibitChild } from "./sleepInhibit.js";
import { readDaemonState } from "./state.js";

const execFileAsync = promisify(execFile);

/**
 * Proves `commands.ts`'s `runDaemonStartSync` actually wires
 * `machineClient.ts` + `machineRpc.ts` into a live boot (this task) rather
 * than leaving the old "not implemented yet" stub reachable — `spawn`,
 * `resumeSession`, `adopt.take`, and `git.status` are called for real, over
 * a real Socket.IO `rpc-call` round trip, against a real `@falcon/server`
 * app (real Fastify routes, real in-memory Postgres — same "real server,
 * not a mock" posture as `session/bootstrap.integration.test.ts`).
 *
 * No real provider CLI is ever spawned: `spawnEngineOverrides`/
 * `resumeSessionOverrides` swap in a fake process launcher that mints a pid
 * and, shortly after, self-reports via the *real* `notify.ts` client hitting
 * the daemon's own *real* control server `/session-started` endpoint —
 * exactly what a real `falcon claude --starting-mode remote` process would
 * do. That, in turn, exercises the real `spawnAwaiter`/`onSessionStarted`
 * wiring this task added to `runDaemonStartSync`, not just the RPC decrypt/
 * validate/handle/seal pipeline in isolation.
 */
describe("runDaemonStartSync (integration: machine client + RPC handlers over a real socket)", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let serverUrl: string;
  let token: string;
  let accountId: string;

  let homeDir: string;
  let workspaceDir: string;
  let masterSecret: Uint8Array;
  let dek: Uint8Array | null;
  let machineId: string;
  let caller: ClientSocket;
  let triggerShutdown: (() => void) | undefined;
  let bootPromise: Promise<number> | undefined;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    app = await buildServer({ logger: false }, { db });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${address.port}`;

    const account = await createTestAccount(db);
    token = account.token;
    accountId = account.account.id;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-machine-wiring-int-"));
    workspaceDir = await mkdtemp(path.join(tmpdir(), "falcon-machine-wiring-ws-"));
    await execFileAsync("git", ["init"], { cwd: workspaceDir });

    masterSecret = getRandomBytes(32);
    writeCredentials({ token, masterSecretOrContentBundle: encodeBase64(masterSecret) }, homeDir);

    dek = null;
    triggerShutdown = undefined;
    bootPromise = undefined;
  });

  afterEach(async () => {
    caller?.close();
    if (triggerShutdown) {
      triggerShutdown();
      await bootPromise;
    }
    await rm(homeDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  function noopLogger(): Logger {
    return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  }

  /** Fake process launcher: mints a pid, then self-reports via the real `notify.ts` client — never actually spawns a subprocess. */
  function buildFakeLaunchProcess(): (opts: LaunchProcessOptions) => Promise<LaunchedProcess> {
    let nextPid = 900_000;
    return async (opts: LaunchProcessOptions): Promise<LaunchedProcess> => {
      const pid = nextPid++;
      setTimeout(() => {
        void notifyDaemonSessionStarted(
          createNotifyDaemonSessionStartedDeps({
            homeDir,
            fetchImpl: fetch,
            isProcessAlive: () => true,
          }),
          {
            sessionId: `sess_${pid}`,
            pid,
            metadata: { directory: opts.cwd },
            encryption: {
              encryptionKey: "fake-wrapped-key",
              seq: 0,
              metadataVersion: 0,
              agentStateVersion: 0,
            },
          },
        );
      }, 20);
      return { method: "detached", pid };
    };
  }

  /** Fake sleep-inhibit child (docs/features/sleep-inhibit.md): never spawns a real `caffeinate` — forcing `platform: "darwin"` on the real `createSleepInhibitManager` exercises the real argv/state logic while this stands in for the OS process. */
  function fakeSleepInhibitSpawnChild(): (argv: string[]) => SleepInhibitChild {
    return (_argv: string[]) => ({
      pid: 123_456,
      kill: () => true,
      onExit: () => {},
    });
  }

  async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 8000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await fn();
      if (result !== null && result !== undefined) return result;
      if (Date.now() >= deadline) throw new Error("waitFor: timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function callRpc<T>(method: string, params: unknown): Promise<T> {
    if (!dek) throw new Error("callRpc: dek not resolved yet");
    const response = (await caller.timeout(20_000).emitWithAck("rpc-call", {
      target: `m:${machineId}:${method}`,
      method,
      params: seal(params, dek),
    })) as { ok: true; result: EncryptedBox } | { ok: false; error: string };

    if (!response.ok) {
      throw new Error(`rpc-call ${method} failed: ${response.error}`);
    }
    const opened = open<T>(response.result, dek);
    if (opened === null) throw new Error(`rpc-call ${method}: failed to decrypt result`);
    return opened;
  }

  it("boots a daemon and serves spawn/resumeSession/adopt.take/git.status live over the socket", async () => {
    const fakeLaunchProcess = buildFakeLaunchProcess();

    const deps: DaemonCommandDeps = createDaemonCommandDeps({
      homeDir,
      logger: noopLogger(),
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

    bootPromise = runDaemonStartSync(deps);

    // Boot far enough to have written daemon.state.json (control server up,
    // lock acquired) — the machine client + RPC handlers start right after.
    await waitFor(() => readDaemonState(homeDir));

    // Recover this machine's row (proves `registerOrResumeMachine`'s real
    // `POST /v1/machines` succeeded) and, from it, the raw DEK — unwrapped
    // with the SAME masterSecret this test wrote to `access.key`, exactly
    // how any other real client (e.g. the web app) would recover it.
    const machineRow = await waitFor(() =>
      db.query.machines.findFirst({ where: (m, { eq }) => eq(m.accountId, accountId) }),
    );
    machineId = machineRow.id;
    const contentSecretKey = deriveKeyTree(masterSecret).content.secretKey;
    dek = unwrapDek(machineRow.dek, contentSecretKey);
    expect(dek).not.toBeNull();

    caller = ioClient(serverUrl, {
      path: "/v1/stream",
      transports: ["websocket"],
      auth: { token },
    });
    await new Promise<void>((resolve) => caller.once("connect", () => resolve()));

    // `git.status` — no fake-launch machinery involved, real `git` binary
    // against the real temp workspace repo.
    const status = await callRpc<{ branch: string; files: unknown[] }>("git.status", {
      idempotencyKey: "idem-git-1",
      worktree: workspaceDir,
    });
    expect(typeof status.branch).toBe("string");
    expect(Array.isArray(status.files)).toBe(true);

    // `spawn` — real spawnEngine.ts workspace validation, real (faked)
    // process launch, real spawnAwaiter pid↔webhook match via a real HTTP
    // self-report to the daemon's own real control server.
    const spawned = await callRpc<{ sessionId?: string }>("spawn", {
      idempotencyKey: "idem-spawn-1",
      workspaceId: "ws_1",
      directory: workspaceDir,
      provider: "claude-code",
      permissionMode: "default",
    });
    expect(spawned.sessionId).toBeTruthy();

    // `resumeSession` — resumes the session `spawn` just started (still
    // live-tracked with encryption material, so `findResumable` finds it).
    const resumed = await callRpc<{ ok: boolean }>("resumeSession", {
      sessionId: spawned.sessionId,
    });
    expect(resumed.ok).toBe(true);

    // `adopt.take` (mode: fork — no owning process to kill) — real
    // providerSessionResolver seam + real spawnEngine underneath.
    const adopted = await callRpc<{ sessionId: string }>("adopt.take", {
      idempotencyKey: "idem-adopt-1",
      providerSessionId: "prov_1",
      mode: "fork",
    });
    expect(adopted.sessionId).toBeTruthy();
  });

  it("sleepInhibit.set persists to settings.json and sleepInhibit.get reflects the applied state (docs/features/sleep-inhibit.md)", async () => {
    // A fresh account/token — the shared `accountId`/`token` from `beforeAll`
    // already owns a machine row from the prior test in this file (same
    // db/pglite instance across every test here), and `db.query.machines
    // .findFirst({ where: eq(accountId, ...) })` below would otherwise
    // ambiguously match that OTHER test's row instead of this boot's own.
    const account = await createTestAccount(db);
    writeCredentials(
      { token: account.token, masterSecretOrContentBundle: encodeBase64(masterSecret) },
      homeDir,
    );

    const deps: DaemonCommandDeps = createDaemonCommandDeps({
      homeDir,
      logger: noopLogger(),
      registerShutdownSignals: (onShutdown) => {
        triggerShutdown = onShutdown;
        return () => {};
      },
      isProcessAlive: () => true,
      machineServerUrl: serverUrl,
      resolveWorkspaceRoot: () => null,
      resolveProviderSession: async () => null,
      // Real `createSleepInhibitManager` logic (real argv table, real
      // supported/active bookkeeping), but `platform` forced to "darwin" and
      // `spawnChild` faked — never spawns a real `caffeinate` from this test
      // process (this module's own header risk: "tests accidentally
      // spawning real caffeinate").
      createSleepInhibitManager: (managerDeps) =>
        createSleepInhibitManager({
          ...managerDeps,
          platform: "darwin",
          spawnChild: fakeSleepInhibitSpawnChild(),
        }),
    });

    bootPromise = runDaemonStartSync(deps);
    await waitFor(() => readDaemonState(homeDir));

    const machineRow = await waitFor(() =>
      db.query.machines.findFirst({
        where: (m, { eq }) => eq(m.accountId, account.account.id),
      }),
    );
    machineId = machineRow.id;
    const contentSecretKey = deriveKeyTree(masterSecret).content.secretKey;
    dek = unwrapDek(machineRow.dek, contentSecretKey);
    expect(dek).not.toBeNull();

    caller = ioClient(serverUrl, {
      path: "/v1/stream",
      transports: ["websocket"],
      auth: { token: account.token },
    });
    await new Promise<void>((resolve) => caller.once("connect", () => resolve()));

    // Boot re-apply defaults to "off" (no persisted mode yet) — this is the
    // "not yet set" baseline, not a boot failure.
    const initial = await callRpc<{
      supported: boolean;
      platform: string;
      mode: string;
      active: boolean;
    }>("sleepInhibit.get", { idempotencyKey: "idem-sleep-get-1" });
    expect(initial).toEqual({ supported: true, platform: "darwin", mode: "off", active: false });

    const setResult = await callRpc<{
      supported: boolean;
      platform: string;
      mode: string;
      active: boolean;
    }>("sleepInhibit.set", { idempotencyKey: "idem-sleep-set-1", mode: "always" });
    expect(setResult).toEqual({
      supported: true,
      platform: "darwin",
      mode: "always",
      active: true,
    });

    // The set RPC's own handler persisted the mode to settings.json —
    // proving the real `commands.ts` closure (not a test-local stand-in)
    // actually wrote it, not just that the manager's in-memory state changed.
    expect((await readSettings({ homeDir })).sleepInhibit).toBe("always");

    // A follow-up get reflects the same post-apply state without needing
    // another set.
    const afterSet = await callRpc<{
      supported: boolean;
      platform: string;
      mode: string;
      active: boolean;
    }>("sleepInhibit.get", { idempotencyKey: "idem-sleep-get-2" });
    expect(afterSet).toEqual({ supported: true, platform: "darwin", mode: "always", active: true });
  });
});
