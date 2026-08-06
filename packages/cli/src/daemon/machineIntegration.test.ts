import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeBase64, deriveKeyTree, getRandomBytes, unwrapDek } from "@kvy/crypto";
import type { EncryptedBox, MachineRow } from "@kvy/wire";
import type { Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KvyCredentials } from "../auth/credentials.js";
import { plaintextFallbackKeyMaterial } from "../auth/keyMaterial.js";
import type { Logger } from "../logger.js";
import { createMachineIntegrationDeps, startMachineIntegration } from "./machineIntegration.js";
import { createSpawnAwaiter } from "./spawnAwaiter.js";
import { readDaemonState, writeDaemonState } from "./state.js";

// Preview-tunnel wiring: spied on
// rather than exercised end-to-end here — `previewTunnel.test.ts`/
// `tunnelRegistry.test.ts` already cover `reapOrphanedTunnels`'s and
// `closeAllTunnels`'s real kill/journal behavior in depth. This file only
// needs to prove `startMachineIntegration` actually WIRES them in: reaping
// once at boot, closing everything on `stop()`.
vi.mock("./tunnelRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tunnelRegistry.js")>();
  return { ...actual, reapOrphanedTunnels: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("./previewTunnel.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./previewTunnel.js")>();
  return { ...actual, closeAllTunnels: vi.fn().mockResolvedValue(undefined) };
});
// Wraps the real `startTranscriptIndexer` (so it still boots/stops cleanly)
// while exposing every call's `deps` — the only way to reach the `isManaged`
// closure `startMachineIntegration` builds and hands it, since that closure
// isn't part of `MachineIntegrationHandle`'s own return shape.
vi.mock("./transcriptIndexer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transcriptIndexer.js")>();
  return {
    ...actual,
    startTranscriptIndexer: vi.fn((deps: Parameters<typeof actual.startTranscriptIndexer>[0]) =>
      actual.startTranscriptIndexer(deps),
    ),
  };
});

/** Minimal fake standing in for a socket.io-client `Socket` (mirrors `machineRpc.test.ts`'s `FakeSocket`). */
class FakeSocket {
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  connected = false;
  closed = false;

  on(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  off(): void {}
  emit(): void {}
  connect(): void {}
  close(): void {
    this.closed = true;
  }
}

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function fakeBox(): EncryptedBox {
  return { t: "enc", v: 1, c: "ciphertext" };
}

/**
 * A tiny in-memory stand-in for `POST /v1/machines`: stores `dek` only on
 * first registration (no `machineId` in the request body) and echoes it
 * back on every later resume — exactly like the real route (`machines.ts`'s
 * own doc comment: "rotating a machine's DEK is out of scope for this
 * route") — so a test can assert a resumed boot gets back the SAME `dek`
 * it originally registered, never a caller-supplied fresh one.
 */
function fakeServer() {
  let machineId: string | null = null;
  let storedDek: string | null = null;
  let registrations = 0;

  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    // that calls `/v1/auth/refresh` through this same injected `fetchImpl` — handle it
    // distinctly so it doesn't fall into (and pollute the registration count of) the
    // `/v1/machines` branch below.
    if (url.toString().endsWith("/v1/auth/refresh")) {
      return new Response(
        JSON.stringify({ accessToken: "test-token", refreshToken: "test-refresh-token" }),
        { status: 200 },
      );
    }

    const body = JSON.parse(init?.body as string) as { machineId?: string; dek?: string };
    if (!body.machineId) {
      registrations++;
      machineId = `mach_${registrations}`;
      storedDek = body.dek ?? null;
      const row: MachineRow = {
        id: machineId,
        accountId: "acct_1",
        metadata: { value: fakeBox(), version: 0 },
        daemonState: { value: fakeBox(), version: 0 },
        dek: storedDek ?? "",
        lastSeenAt: null,
      };
      return new Response(JSON.stringify(row), { status: 201 });
    }
    // Resume: the real route never re-reads/rotates `dek` here — keep
    // whatever was stored at first registration.
    const row: MachineRow = {
      id: body.machineId,
      accountId: "acct_1",
      metadata: { value: fakeBox(), version: 1 },
      daemonState: { value: fakeBox(), version: 1 },
      dek: storedDek ?? "",
      lastSeenAt: null,
    };
    return new Response(JSON.stringify(row), { status: 200 });
  });

  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    registrationCount: () => registrations,
  };
}

describe("startMachineIntegration — DEK survives a crash-restart", () => {
  let homeDir: string;
  let masterSecret: Uint8Array;
  let credentials: KvyCredentials;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-machine-integration-"));
    masterSecret = getRandomBytes(32);
    credentials = {
      refreshToken: "test-refresh-token",
      keyMaterial: plaintextFallbackKeyMaterial(masterSecret),
    };
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("reuses the same machineId and DEK on a second boot that finds a prior daemon.state.json", async () => {
    const server = fakeServer();

    // Mirrors `commands.ts`'s own boot sequence: the control server writes
    // `daemon.state.json` (pid/port/version/startedAt, no `machineId` yet)
    // before `startMachineIntegration` ever runs.
    await writeDaemonState(homeDir, { pid: 1111, port: 2222, version: "0.0.1", startedAt: 1 });

    const deps1 = createMachineIntegrationDeps(
      { homeDir, registry: {} as never, awaiter: createSpawnAwaiter() },
      {
        logger: silentLogger(),
        serverUrl: "http://localhost:4000",
        fetchImpl: server.fetchImpl,
        ioFactory: () => new FakeSocket() as unknown as Socket,
        readCredentials: () => credentials,
      },
    );

    const handle1 = await startMachineIntegration(deps1);
    expect(handle1).not.toBeNull();
    const stateAfterBoot1 = await readDaemonState(homeDir);
    expect(stateAfterBoot1?.machineId).toBe(handle1?.machineId);
    expect(stateAfterBoot1?.wrappedDek).toBeTruthy();
    const wrappedDekAfterBoot1 = stateAfterBoot1?.wrappedDek as string;

    // Simulate a crash: `handle1.stop()` (no clean shutdown / no
    // `clearDaemonState`) — `daemon.state.json` is left exactly as the
    // still-running daemon last wrote it, same as a killed process would
    // leave it.
    handle1?.stop();

    // Mirrors `commands.ts`'s fixed boot sequence: carry the previous
    // `machineId`/`wrappedDek` forward into the fresh payload instead of
    // clobbering them.
    const previous = await readDaemonState(homeDir);
    await writeDaemonState(homeDir, {
      pid: 3333,
      port: 4444,
      version: "0.0.1",
      startedAt: 2,
      machineId: previous?.machineId,
      wrappedDek: previous?.wrappedDek,
    });

    const deps2 = createMachineIntegrationDeps(
      { homeDir, registry: {} as never, awaiter: createSpawnAwaiter() },
      {
        logger: silentLogger(),
        serverUrl: "http://localhost:4000",
        fetchImpl: server.fetchImpl,
        ioFactory: () => new FakeSocket() as unknown as Socket,
        readCredentials: () => credentials,
      },
    );

    const handle2 = await startMachineIntegration(deps2);
    expect(handle2).not.toBeNull();

    // Same machine row resumed, not a second brand-new registration.
    expect(handle2?.machineId).toBe(handle1?.machineId);
    expect(server.registrationCount()).toBe(1);

    // The exact same wrapped DEK survived the "crash" — a fresh mismatched
    // one was NOT minted on the second boot.
    const stateAfterBoot2 = await readDaemonState(homeDir);
    expect(stateAfterBoot2?.wrappedDek).toBe(wrappedDekAfterBoot1);

    // And it genuinely unwraps to the same raw bytes under this account's
    // content key — the actual key `registerMachineRpcHandlers` seals/opens
    // every machine RPC with.
    const contentSecretKey = deriveKeyTree(masterSecret).content.secretKey;
    const raw1 = unwrapDek(decodeBase64(wrappedDekAfterBoot1), contentSecretKey);
    const raw2 = unwrapDek(decodeBase64(stateAfterBoot2?.wrappedDek as string), contentSecretKey);
    expect(raw1).not.toBeNull();
    expect(raw2).toEqual(raw1);

    await handle2?.stop();
  });
});

describe("startMachineIntegration — preview-tunnel wiring", () => {
  let homeDir: string;
  let masterSecret: Uint8Array;
  let credentials: KvyCredentials;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-machine-integration-preview-"));
    masterSecret = getRandomBytes(32);
    credentials = {
      refreshToken: "test-refresh-token",
      keyMaterial: plaintextFallbackKeyMaterial(masterSecret),
    };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  function deps(server: ReturnType<typeof fakeServer>) {
    return createMachineIntegrationDeps(
      { homeDir, registry: {} as never, awaiter: createSpawnAwaiter() },
      {
        logger: silentLogger(),
        serverUrl: "http://localhost:4000",
        fetchImpl: server.fetchImpl,
        ioFactory: () => new FakeSocket() as unknown as Socket,
        readCredentials: () => credentials,
      },
    );
  }

  it("reaps orphaned tunnels once at boot", async () => {
    const { reapOrphanedTunnels } = await import("./tunnelRegistry.js");
    const server = fakeServer();

    const handle = await startMachineIntegration(deps(server));

    expect(handle).not.toBeNull();
    expect(reapOrphanedTunnels).toHaveBeenCalledExactlyOnceWith(homeDir);

    await handle?.stop();
  });

  it("stop() closes every tracked tunnel", async () => {
    const { closeAllTunnels } = await import("./previewTunnel.js");
    const server = fakeServer();

    const handle = await startMachineIntegration(deps(server));
    expect(closeAllTunnels).not.toHaveBeenCalled();

    await handle?.stop();

    expect(closeAllTunnels).toHaveBeenCalledTimes(1);
  });
});

describe("startMachineIntegration — transcript indexer isManaged wiring", () => {
  let homeDir: string;
  let masterSecret: Uint8Array;
  let credentials: KvyCredentials;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-machine-integration-transcript-"));
    masterSecret = getRandomBytes(32);
    credentials = {
      refreshToken: "test-refresh-token",
      keyMaterial: plaintextFallbackKeyMaterial(masterSecret),
    };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  // Confirms the regression this fix closes: `startTranscriptIndexer` used
  // to be wired with no `isManaged` override at all here, so it silently
  it("wires isManaged to the injected registry's isProviderSessionManaged, not the indexer's own no-op default", async () => {
    const { startTranscriptIndexer } = await import("./transcriptIndexer.js");
    const isProviderSessionManaged = vi.fn(
      (providerSessionId: string) => providerSessionId === "provider-abc",
    );
    const registry = {
      getSessions: () => [],
      isProviderSessionManaged,
    };

    const handle = await startMachineIntegration(
      createMachineIntegrationDeps(
        { homeDir, registry: registry as never, awaiter: createSpawnAwaiter() },
        {
          logger: silentLogger(),
          serverUrl: "http://localhost:4000",
          fetchImpl: fakeServer().fetchImpl,
          ioFactory: () => new FakeSocket() as unknown as Socket,
          readCredentials: () => credentials,
        },
      ),
    );
    expect(handle).not.toBeNull();

    expect(startTranscriptIndexer).toHaveBeenCalledTimes(1);
    const indexerDeps = vi.mocked(startTranscriptIndexer).mock.calls[0]?.[0];
    expect(indexerDeps).toBeDefined();

    expect(await indexerDeps?.isManaged("provider-abc")).toBe(true);
    expect(await indexerDeps?.isManaged("provider-unrelated")).toBe(false);
    expect(isProviderSessionManaged).toHaveBeenCalledWith("provider-abc");
    expect(isProviderSessionManaged).toHaveBeenCalledWith("provider-unrelated");

    await handle?.stop();
  });
});

describe("startMachineIntegration — transcript indexer opaque-workspaceId resolution", () => {
  let homeDir: string;
  let masterSecret: Uint8Array;
  let credentials: KvyCredentials;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-machine-integration-workspace-id-"));
    masterSecret = getRandomBytes(32);
    credentials = {
      refreshToken: "test-refresh-token",
      keyMaterial: plaintextFallbackKeyMaterial(masterSecret),
    };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  /** Wraps `fakeServer()`'s fetch (handles `/v1/auth/refresh` + `/v1/machines`
   * already) with `/v1/workspaces` and `/v1/unmanaged-sessions` handling —
   * `workspacesFetch` lets each test control the `/v1/workspaces` response
   * per call (to simulate a transient failure then a later success). */
  function fetchImplWithWorkspaces(
    machinesFetch: typeof fetch,
    workspacesFetch: (call: number) => Response,
  ) {
    let workspacesCallCount = 0;
    return vi.fn(async (url: string, init?: RequestInit) => {
      const href = url.toString();
      if (href.endsWith("/v1/workspaces")) {
        workspacesCallCount++;
        return workspacesFetch(workspacesCallCount);
      }
      if (href.endsWith("/v1/unmanaged-sessions")) {
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      return machinesFetch(url, init);
    }) as unknown as typeof fetch;
  }

  function upsertParams(overrides: Partial<{ workspaceId: string; providerRef: string }> = {}) {
    return {
      machineId: "mach-irrelevant",
      workspaceId: "/real/repo/path",
      providerRef: "provider-1",
      summary: { title: "t", lastActivity: 0, running: false },
      ...overrides,
    };
  }

  it("retries workspace-id resolution on a later upsert after a transient failure, instead of caching the null forever", async () => {
    const machinesFetch = fakeServer().fetchImpl;
    // First `/v1/workspaces` call fails (transient network/auth error); the second succeeds.
    const fetchImpl = fetchImplWithWorkspaces(machinesFetch, (call) =>
      call === 1
        ? new Response("server error", { status: 500 })
        : new Response(
            JSON.stringify({
              id: "ws_opaque_1",
              accountId: "acct_1",
              pathHash: "hash",
              metadata: { value: { t: "enc", v: 1, c: "x" }, version: 0 },
              dek: "",
            }),
            { status: 201 },
          ),
    );

    const { startTranscriptIndexer } = await import("./transcriptIndexer.js");
    const handle = await startMachineIntegration(
      createMachineIntegrationDeps(
        { homeDir, registry: { getSessions: () => [] } as never, awaiter: createSpawnAwaiter() },
        {
          logger: silentLogger(),
          serverUrl: "http://localhost:4000",
          fetchImpl,
          ioFactory: () => new FakeSocket() as unknown as Socket,
          readCredentials: () => credentials,
        },
      ),
    );
    expect(handle).not.toBeNull();
    const indexerDeps = vi.mocked(startTranscriptIndexer).mock.calls[0]?.[0];
    expect(indexerDeps).toBeDefined();

    // First upsert: workspace-id resolution fails, so the upsert itself is
    // skipped (no unmanaged-session row created for unresolvable workspace data).
    const firstResult = await indexerDeps?.upsert(upsertParams());
    expect(firstResult).toBe(false);

    // Second upsert, same real path: must retry resolution (not replay a
    // cached `null`) and succeed once the transient failure has cleared.
    const secondResult = await indexerDeps?.upsert(upsertParams());
    expect(secondResult).toBe(true);

    await handle?.stop();
  });

  it("caches a successful workspace-id resolution: a later upsert for the same path doesn't re-hit /v1/workspaces", async () => {
    const machinesFetch = fakeServer().fetchImpl;
    const workspacesFetch = vi.fn(
      (): Response =>
        new Response(
          JSON.stringify({
            id: "ws_opaque_1",
            accountId: "acct_1",
            pathHash: "hash",
            metadata: { value: { t: "enc", v: 1, c: "x" }, version: 0 },
            dek: "",
          }),
          { status: 201 },
        ),
    );
    const fetchImpl = fetchImplWithWorkspaces(machinesFetch, workspacesFetch);

    const { startTranscriptIndexer } = await import("./transcriptIndexer.js");
    const handle = await startMachineIntegration(
      createMachineIntegrationDeps(
        { homeDir, registry: { getSessions: () => [] } as never, awaiter: createSpawnAwaiter() },
        {
          logger: silentLogger(),
          serverUrl: "http://localhost:4000",
          fetchImpl,
          ioFactory: () => new FakeSocket() as unknown as Socket,
          readCredentials: () => credentials,
        },
      ),
    );
    const indexerDeps = vi.mocked(startTranscriptIndexer).mock.calls[0]?.[0];

    expect(await indexerDeps?.upsert(upsertParams())).toBe(true);
    expect(await indexerDeps?.upsert(upsertParams({ providerRef: "provider-2" }))).toBe(true);

    expect(workspacesFetch).toHaveBeenCalledTimes(1);

    await handle?.stop();
  });
});
