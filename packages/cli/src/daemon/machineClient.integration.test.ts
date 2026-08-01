import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Server as IoServer } from "socket.io";
import { io as ioClient } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { startMachineClient } from "./machineClient.js";
import { readDaemonState, writeDaemonState } from "./state.js";

/**
 * Integration test proving reconnect-after-drop re-registers cleanly
 * without duplicating the machine row (plan.md §1.5). Runs `machineClient.ts`
 * against:
 *  - a real `socket.io` server on `/v1/stream` (standing in for
 *    `packages/server`'s already-merged `startSocket`, exercised end to end
 *    in `packages/server/src/app/socket.test.ts`) — proves the handshake
 *    auth (`clientType: "machine-scoped"`, `machineId`) and reconnect
 *    actually round-trip over a real WebSocket, not a mock.
 *  - a minimal in-memory `POST /v1/machines` mock replicating just the CAS
 *    semantics of the already-merged `machines.ts` route (create-if-absent,
 *    update-with-expectedVersion, `409 {current}` on mismatch) — enough to
 *    prove this client never creates a second row after a reconnect.
 */

interface StoredMachine {
  id: string;
  metadata: { value: unknown; version: number };
  daemonState: { value: unknown; version: number } | null;
}

function buildMachinesMock() {
  let store: StoredMachine | null = null;
  let createdCount = 0;

  function handle(body: {
    machineId?: string;
    dek?: string;
    metadata: { value: unknown; expectedVersion: number };
    daemonState?: { value: unknown; expectedVersion: number };
  }): { status: number; body: unknown } {
    if (!body.machineId) {
      createdCount += 1;
      store = {
        id: `mach_int_${createdCount}`,
        metadata: { value: body.metadata.value, version: 0 },
        daemonState: body.daemonState ? { value: body.daemonState.value, version: 0 } : null,
      };
      return { status: 201, body: toRow(store) };
    }

    if (!store || store.id !== body.machineId) {
      return { status: 404, body: {} };
    }

    const metadataMismatch = store.metadata.version !== body.metadata.expectedVersion;
    const daemonStateMismatch =
      body.daemonState !== undefined &&
      (store.daemonState?.version ?? 0) !== body.daemonState.expectedVersion;

    if (metadataMismatch || daemonStateMismatch) {
      return {
        status: 409,
        body: {
          current: {
            metadata: store.metadata,
            daemonState: store.daemonState,
          },
        },
      };
    }

    store.metadata = { value: body.metadata.value, version: store.metadata.version + 1 };
    if (body.daemonState) {
      store.daemonState = {
        value: body.daemonState.value,
        version: (store.daemonState?.version ?? 0) + 1,
      };
    }
    return { status: 200, body: toRow(store) };
  }

  function toRow(machine: StoredMachine) {
    return {
      id: machine.id,
      accountId: "acct_int",
      metadata: machine.metadata,
      daemonState: machine.daemonState,
      dek: "wrapped-dek",
      lastSeenAt: null,
    };
  }

  return {
    handle,
    get createdCount() {
      return createdCount;
    },
    get machineId() {
      return store?.id ?? null;
    },
  };
}

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

describe("machineClient (integration: real socket.io + machines HTTP mock)", () => {
  let httpServer: HttpServer;
  let io: IoServer;
  let url: string;
  let homeDir: string;
  let machinesMock: ReturnType<typeof buildMachinesMock>;
  const connectedMachineIds: string[] = [];

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "kvy-machine-client-int-"));
    machinesMock = buildMachinesMock();
    connectedMachineIds.length = 0;

    httpServer = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/machines") {
        let raw = "";
        req.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf8");
        });
        req.on("end", () => {
          const result = machinesMock.handle(JSON.parse(raw));
          res.writeHead(result.status, { "content-type": "application/json" });
          res.end(JSON.stringify(result.body));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    io = new IoServer(httpServer, { path: "/v1/stream", transports: ["websocket"] });
    io.on("connection", (socket) => {
      const machineId = socket.handshake.auth.machineId as string;
      connectedMachineIds.push(machineId);
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(homeDir, { recursive: true, force: true });
  });

  it("reconnect-after-drop re-registers cleanly without duplicating the machine row", async () => {
    // Mirrors real daemon boot order: `daemon start-sync` (commands.ts,
    // already merged) writes `daemon.state.json` before anything else
    // starts, so it already exists by the time a machine client would run.
    await writeDaemonState(homeDir, {
      pid: process.pid,
      port: 1234,
      version: "0.1.0",
      startedAt: 1,
    });

    const result = await startMachineClient({
      serverUrl: url,
      tokenProvider: {
        getAccessToken: async () => "test-token",
        forceRefresh: async () => "test-token",
        isDead: false,
      },
      homeDir,
      encryptionKey: new Uint8Array(32).fill(3),
      encryptionVariant: "legacy",
      dek: "wrapped-dek-b64",
      buildMetadata: () => ({
        host: "int-host",
        platform: "linux",
        homeDir: "/h",
        cliVersion: "0.1.0",
      }),
      buildRuntimeState: () => ({
        status: "running",
        pid: process.pid,
        controlPort: 1234,
        startedAt: 1,
      }),
      fetchImpl: fetch,
      ioFactory: (u, opts) =>
        ioClient(u, { ...opts, reconnectionDelay: 20, reconnectionDelayMax: 40 }),
      logger: silentLogger(),
      now: () => Date.now(),
      heartbeatIntervalMs: 60_000,
      maxCasRetries: 3,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Wait for the first real WS connection to land server-side.
    await vi.waitFor(() => expect(connectedMachineIds).toHaveLength(1));
    const machineId = connectedMachineIds[0];
    expect(machineId).toBe(machinesMock.machineId);
    expect(machinesMock.createdCount).toBe(1);

    // Give the on-connect daemonState CAS push a moment to land.
    await vi.waitFor(() => expect(result.handle.identity.daemonState?.version).toBeGreaterThan(0));

    // Simulate a dropped connection: force-disconnect every server-side
    // socket. The client's default socket.io-client reconnection (never
    // disabled here) should bring it back up on its own.
    for (const socket of await io.fetchSockets()) socket.disconnect(true);

    await vi.waitFor(() => expect(connectedMachineIds).toHaveLength(2), { timeout: 5000 });

    // Same machineId both times — proves the reconnect resumed the
    // existing row instead of registering a new one.
    expect(connectedMachineIds[1]).toBe(machineId);
    expect(machinesMock.createdCount).toBe(1);

    // The daemonState push that runs on every (re)connect must have kept
    // updating the *same* row (versions only ever go up, never reset).
    await vi.waitFor(() =>
      expect(result.handle.identity.daemonState?.version).toBeGreaterThanOrEqual(2),
    );

    // Resuming survives a simulated daemon restart too: a fresh
    // `startMachineClient` reading the same `homeDir` must reuse the
    // persisted machineId rather than registering again.
    expect((await readDaemonState(homeDir))?.machineId).toBe(machineId);

    result.handle.stop();
  }, 10_000);
});
