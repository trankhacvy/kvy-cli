import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EncryptedBox } from "@falcon/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import type {
  MachineClientDeps,
  MachineFieldSnapshot,
  MachineMetadata,
  MachineRuntimeState,
} from "./machineClient.js";
import {
  persistMachineId,
  pushRuntimeState,
  registerOrResumeMachine,
  startMachineClient,
} from "./machineClient.js";
import { readDaemonState, writeDaemonState } from "./state.js";

const FIXED_METADATA: MachineMetadata = {
  host: "test-host",
  platform: "darwin",
  homeDir: "/home/test",
  cliVersion: "0.1.0-test",
};

const FIXED_STATE: MachineRuntimeState = {
  status: "running",
  pid: 4242,
  controlPort: 9999,
  startedAt: 1000,
};

function fakeBox(): EncryptedBox {
  return { t: "enc", v: 1, c: "ciphertext" };
}

function machineRow(overrides: {
  id?: string;
  metadataVersion?: number;
  daemonStateVersion?: number | null;
}) {
  const { id = "mach_1", metadataVersion = 0, daemonStateVersion = 0 } = overrides;
  return {
    id,
    accountId: "acct_1",
    metadata: { value: fakeBox(), version: metadataVersion },
    daemonState:
      daemonStateVersion === null ? null : { value: fakeBox(), version: daemonStateVersion },
    dek: "wrapped-dek",
    lastSeenAt: null,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function buildDeps(overrides: Partial<MachineClientDeps> = {}, homeDir = "/tmp/unused"): MachineClientDeps {
  return {
    serverUrl: "http://localhost:4000",
    token: "test-token",
    homeDir,
    encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant: "legacy",
    dek: "wrapped-dek-b64",
    buildMetadata: () => FIXED_METADATA,
    buildRuntimeState: () => FIXED_STATE,
    fetchImpl: vi.fn(),
    ioFactory: vi.fn(),
    logger: silentLogger(),
    now: () => 5000,
    heartbeatIntervalMs: 60_000,
    maxCasRetries: 3,
    ...overrides,
  };
}

describe("registerOrResumeMachine", () => {
  it("registers a brand new machine (no existingMachineId) sending the wrapped dek", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, machineRow({})));
    const deps = buildDeps({ fetchImpl });

    const result = await registerOrResumeMachine(deps, null);

    expect(result).toEqual({
      ok: true,
      identity: {
        machineId: "mach_1",
        metadata: { value: FIXED_METADATA, version: 0 },
        daemonState: { value: FIXED_STATE, version: 0 },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:4000/v1/machines");
    const body = JSON.parse(init.body as string);
    expect(body.machineId).toBeUndefined();
    expect(body.dek).toBe("wrapped-dek-b64");
    expect(body.metadata.expectedVersion).toBe(0);
    expect(body.daemonState.expectedVersion).toBe(0);
  });

  it("resumes an existing machineId via a plain update (200, no conflict)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, machineRow({ id: "mach_9", metadataVersion: 3, daemonStateVersion: 2 })));
    const deps = buildDeps({ fetchImpl });

    const result = await registerOrResumeMachine(deps, "mach_9");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.machineId).toBe("mach_9");
      expect(result.identity.metadata.version).toBe(3);
      expect(result.identity.daemonState?.version).toBe(2);
    }
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.machineId).toBe("mach_9");
    expect(body.dek).toBeUndefined();
  });

  it("retries a 409 conflict by re-reading `current` and resubmitting, succeeding within maxCasRetries", async () => {
    const conflictCurrent = {
      metadata: { value: fakeBox(), version: 5 } as MachineFieldSnapshot<EncryptedBox>,
      daemonState: { value: fakeBox(), version: 4 } as MachineFieldSnapshot<EncryptedBox>,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(409, { current: conflictCurrent }))
      .mockResolvedValueOnce(
        jsonResponse(200, machineRow({ id: "mach_5", metadataVersion: 6, daemonStateVersion: 5 })),
      );
    const deps = buildDeps({ fetchImpl, maxCasRetries: 3 });

    const result = await registerOrResumeMachine(deps, "mach_5");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: true,
      identity: {
        machineId: "mach_5",
        metadata: { value: FIXED_METADATA, version: 6 },
        daemonState: { value: FIXED_STATE, version: 5 },
      },
    });
    // The retried request must carry the server's fresh versions from `current`, not the stale ones.
    const secondBody = JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(secondBody.metadata.expectedVersion).toBe(5);
    expect(secondBody.daemonState.expectedVersion).toBe(4);
  });

  it("gives up after exhausting maxCasRetries on a persistent conflict", async () => {
    const conflictCurrent = {
      metadata: { value: fakeBox(), version: 1 },
      daemonState: { value: fakeBox(), version: 1 },
    };
    // `mockImplementation` (not `mockResolvedValue`) so each call gets a fresh
    // `Response` — a `Response` body can only be read once, and reusing one
    // instance across retries would make the 2nd/3rd `res.json()` throw,
    // masking the real "exhausted retries" behavior under a body-read error.
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(409, { current: conflictCurrent }));
    const deps = buildDeps({ fetchImpl, maxCasRetries: 3 });

    const result = await registerOrResumeMachine(deps, "mach_stuck");

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ok: false, reason: "exhausted 3 CAS retries" });
  });

  it("falls back to a fresh registration when the remembered machineId 404s", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(201, machineRow({ id: "mach_new" })));
    const deps = buildDeps({ fetchImpl });

    const result = await registerOrResumeMachine(deps, "mach_stale");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(secondBody.machineId).toBeUndefined();
    expect(secondBody.dek).toBe("wrapped-dek-b64");
    expect(result).toEqual({
      ok: true,
      identity: {
        machineId: "mach_new",
        metadata: { value: FIXED_METADATA, version: 0 },
        daemonState: { value: FIXED_STATE, version: 0 },
      },
    });
  });

  it("returns ok:false without retrying on a network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const deps = buildDeps({ fetchImpl });

    const result = await registerOrResumeMachine(deps, null);

    expect(result).toEqual({ ok: false, reason: "ECONNREFUSED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("pushRuntimeState", () => {
  it("sends the identity's tracked versions and updates them from the response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, machineRow({ id: "mach_1", metadataVersion: 1, daemonStateVersion: 1 })));
    const deps = buildDeps({ fetchImpl });

    const identity = {
      machineId: "mach_1",
      metadata: { value: FIXED_METADATA, version: 0 },
      daemonState: { value: FIXED_STATE, version: 0 },
    };

    const result = await pushRuntimeState(deps, identity, { ...FIXED_STATE, status: "running" });

    expect(result.ok).toBe(true);
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.metadata.expectedVersion).toBe(0);
    expect(body.daemonState.expectedVersion).toBe(0);
  });
});

describe("persistMachineId", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-machine-client-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("is a no-op when daemon.state.json does not exist yet", async () => {
    await persistMachineId(homeDir, "mach_1");
    expect(await readDaemonState(homeDir)).toBeNull();
  });

  it("merges machineId into the existing daemon state without disturbing other fields", async () => {
    await writeDaemonState(homeDir, { pid: 111, port: 4567, version: "0.1.0", startedAt: 42 });

    await persistMachineId(homeDir, "mach_1");

    expect(await readDaemonState(homeDir)).toEqual({
      pid: 111,
      port: 4567,
      version: "0.1.0",
      startedAt: 42,
      machineId: "mach_1",
    });
  });

  it("does not rewrite the file when the machineId is already current", async () => {
    await writeDaemonState(homeDir, {
      pid: 111,
      port: 4567,
      version: "0.1.0",
      startedAt: 42,
      machineId: "mach_1",
    });
    const before = await readDaemonState(homeDir);

    await persistMachineId(homeDir, "mach_1");

    expect(await readDaemonState(homeDir)).toEqual(before);
  });
});

/** Minimal fake standing in for a socket.io-client `Socket` (mockable Socket.IO layer). */
class FakeSocket {
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  emitted: { event: string; payload: unknown }[] = [];
  closed = false;

  on(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  close(): void {
    this.closed = true;
  }

  connect(): void {
    // no-op stand-in for socket.io-client's manual-reconnect escape hatch
  }

  trigger(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

describe("startMachineClient", () => {
  it("registers, opens the socket with clientType machine-scoped, and returns a handle", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, machineRow({ id: "mach_ws" })));
    const fakeSocket = new FakeSocket();
    const ioFactory = vi.fn().mockReturnValue(fakeSocket);
    const deps = buildDeps({ fetchImpl, ioFactory: ioFactory as unknown as MachineClientDeps["ioFactory"] });

    const result = await startMachineClient(deps);

    expect(result.ok).toBe(true);
    expect(ioFactory).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:4000",
      expect.objectContaining({
        path: "/v1/stream",
        auth: { token: "test-token", clientType: "machine-scoped", machineId: "mach_ws" },
      }),
    );
    if (result.ok) expect(result.handle.identity.machineId).toBe("mach_ws");
  });

  it("starts a 60s heartbeat emitting machine-alive on connect", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, machineRow({ id: "mach_hb" })));
      const fakeSocket = new FakeSocket();
      const ioFactory = vi.fn().mockReturnValue(fakeSocket);
      const deps = buildDeps({
        fetchImpl,
        ioFactory: ioFactory as unknown as MachineClientDeps["ioFactory"],
        now: () => 12345,
      });

      const result = await startMachineClient(deps);
      expect(result.ok).toBe(true);

      fakeSocket.trigger("connect");
      expect(fakeSocket.emitted).toContainEqual({
        event: "machine-alive",
        payload: { machineId: "mach_hb", time: 12345 },
      });

      const countAfterConnect = fakeSocket.emitted.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fakeSocket.emitted.length).toBe(countAfterConnect + 1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fakeSocket.emitted.length).toBe(countAfterConnect + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pushes daemonState via CAS on connect", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, machineRow({ id: "mach_push", daemonStateVersion: 0 })))
      .mockResolvedValueOnce(
        jsonResponse(200, machineRow({ id: "mach_push", metadataVersion: 0, daemonStateVersion: 1 })),
      );
    const fakeSocket = new FakeSocket();
    const ioFactory = vi.fn().mockReturnValue(fakeSocket);
    const deps = buildDeps({ fetchImpl, ioFactory: ioFactory as unknown as MachineClientDeps["ioFactory"] });

    const result = await startMachineClient(deps);
    expect(result.ok).toBe(true);

    fakeSocket.trigger("connect");
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      if (result.ok) expect(result.handle.identity.daemonState?.version).toBe(1);
    });
  });

  it("stops the heartbeat and closes the socket on stop()", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, machineRow({ id: "mach_stop" })));
      const fakeSocket = new FakeSocket();
      const ioFactory = vi.fn().mockReturnValue(fakeSocket);
      const deps = buildDeps({ fetchImpl, ioFactory: ioFactory as unknown as MachineClientDeps["ioFactory"] });

      const result = await startMachineClient(deps);
      expect(result.ok).toBe(true);
      fakeSocket.trigger("connect");

      if (result.ok) result.handle.stop();
      expect(fakeSocket.closed).toBe(true);

      const countAfterStop = fakeSocket.emitted.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fakeSocket.emitted.length).toBe(countAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the heartbeat on disconnect", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, machineRow({ id: "mach_disc" })));
      const fakeSocket = new FakeSocket();
      const ioFactory = vi.fn().mockReturnValue(fakeSocket);
      const deps = buildDeps({ fetchImpl, ioFactory: ioFactory as unknown as MachineClientDeps["ioFactory"] });

      await startMachineClient(deps);
      fakeSocket.trigger("connect");
      fakeSocket.trigger("disconnect", "transport close");

      const countAfterDisconnect = fakeSocket.emitted.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fakeSocket.emitted.length).toBe(countAfterDisconnect);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists the resolved machineId into daemon.state.json when one exists", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "falcon-machine-client-ws-"));
    try {
      await writeDaemonState(homeDir, { pid: 1, port: 2, version: "0.1.0", startedAt: 0 });
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, machineRow({ id: "mach_persist" })));
      const fakeSocket = new FakeSocket();
      const ioFactory = vi.fn().mockReturnValue(fakeSocket);
      const deps = buildDeps(
        { fetchImpl, ioFactory: ioFactory as unknown as MachineClientDeps["ioFactory"] },
        homeDir,
      );

      await startMachineClient(deps);

      expect((await readDaemonState(homeDir))?.machineId).toBe("mach_persist");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("returns ok:false and never opens a socket when registration fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const ioFactory = vi.fn();
    const deps = buildDeps({ fetchImpl, ioFactory });

    const result = await startMachineClient(deps);

    expect(result).toEqual({ ok: false, reason: "ECONNREFUSED" });
    expect(ioFactory).not.toHaveBeenCalled();
  });
});
