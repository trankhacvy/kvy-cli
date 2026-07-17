import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeBase64, deriveKeyTree, encodeBase64, getRandomBytes, unwrapDek } from "@falcon/crypto";
import type { EncryptedBox, MachineRow } from "@falcon/wire";
import type { Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FalconCredentials } from "../auth/credentials.js";
import type { Logger } from "../logger.js";
import { createMachineIntegrationDeps, startMachineIntegration } from "./machineIntegration.js";
import { createSpawnAwaiter } from "./spawnAwaiter.js";
import { readDaemonState, writeDaemonState } from "./state.js";

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

  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
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

  return { fetchImpl: fetchImpl as unknown as typeof fetch, registrationCount: () => registrations };
}

describe("startMachineIntegration — DEK survives a crash-restart", () => {
  let homeDir: string;
  let masterSecret: Uint8Array;
  let credentials: FalconCredentials;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-machine-integration-"));
    masterSecret = getRandomBytes(32);
    credentials = { token: "test-token", masterSecretOrContentBundle: encodeBase64(masterSecret) };
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

    handle2?.stop();
  });
});
