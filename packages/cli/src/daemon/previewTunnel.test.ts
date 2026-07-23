import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnFn } from "./previewTunnel.js";
import {
  closeAllTunnels,
  handlePreviewClose,
  handlePreviewOpen,
  handlePreviewPorts,
  handlePreviewTunnels,
  type PreviewTunnelDeps,
} from "./previewTunnel.js";
import { appendJournalEntry, createTunnelRegistry, readTunnelJournal } from "./tunnelRegistry.js";

/** Minimal fake `ChildProcess` — an EventEmitter with `stdout`/`stderr` streams, a `pid`, and a spyable `kill`. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined;
  kill = vi.fn();

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }
}

describe("previewTunnel", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-preview-tunnel-test-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  function baseDeps(overrides: Partial<PreviewTunnelDeps> = {}): PreviewTunnelDeps {
    return {
      homeDir,
      registry: createTunnelRegistry(),
      detectCloudflared: vi.fn().mockResolvedValue({ installed: true, version: "2024.6.1" }),
      listListeningPorts: vi.fn().mockResolvedValue([]),
      isAlive: vi.fn().mockReturnValue(false),
      killPid: vi.fn(),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: vi.fn().mockReturnValue(1_000),
      createId: vi.fn().mockReturnValue("tunnel-id-1"),
      urlTimeoutMs: 50,
      gracefulTimeoutMs: 50,
      maxTunnels: 5,
      ...overrides,
    };
  }

  describe("handlePreviewPorts", () => {
    it("composes listListeningPorts + detectCloudflared", async () => {
      const deps = baseDeps({
        listListeningPorts: vi
          .fn()
          .mockResolvedValue([{ port: 3000, address: "*", pid: 1, processName: "node" }]),
        detectCloudflared: vi.fn().mockResolvedValue({ installed: true, version: "2024.6.1" }),
      });

      await expect(handlePreviewPorts({ idempotencyKey: "k1" }, deps)).resolves.toEqual({
        cloudflared: { installed: true, version: "2024.6.1" },
        ports: [{ port: 3000, address: "*", pid: 1, processName: "node" }],
      });
    });
  });

  describe("handlePreviewOpen", () => {
    it("resolves with a url once cloudflared reports it on stderr", async () => {
      const child = new FakeChild(4242);
      const spawnImpl: SpawnFn = vi.fn(() => {
        queueMicrotask(() => {
          child.stderr.emit(
            "data",
            Buffer.from(
              "your quick tunnel has been created at https://foo-bar.trycloudflare.com\n",
            ),
          );
        });
        return child as never;
      });
      const deps = baseDeps({ spawnImpl });

      const result = await handlePreviewOpen({ idempotencyKey: "k1", port: 3000 }, deps);

      expect(result).toEqual({
        tunnelId: "tunnel-id-1",
        url: "https://foo-bar.trycloudflare.com",
        port: 3000,
      });
      expect(deps.registry.get("tunnel-id-1")).toMatchObject({ status: "active" });
      // Journaled immediately at spawn time.
      expect(await readTunnelJournal(homeDir)).toEqual([
        { pid: 4242, port: 3000, startedAt: 1000 },
      ]);
    });

    it("rejects cloudflared-not-installed without spawning anything", async () => {
      const spawnImpl: SpawnFn = vi.fn();
      const deps = baseDeps({
        spawnImpl,
        detectCloudflared: vi.fn().mockResolvedValue({ installed: false }),
      });

      await expect(handlePreviewOpen({ idempotencyKey: "k1", port: 3000 }, deps)).rejects.toThrow(
        "cloudflared-not-installed",
      );
      expect(spawnImpl).not.toHaveBeenCalled();
    });

    it("rejects max-tunnels-reached once the registry is at capacity", async () => {
      const registry = createTunnelRegistry();
      for (let i = 0; i < 2; i++) {
        registry.add({
          tunnelId: `existing-${i}`,
          port: 4000 + i,
          url: `https://existing-${i}.trycloudflare.com`,
          pid: 9000 + i,
          startedAt: 0,
          status: "active",
          child: new FakeChild(9000 + i) as never,
        });
      }
      const spawnImpl: SpawnFn = vi.fn();
      const deps = baseDeps({ registry, spawnImpl, maxTunnels: 2 });

      await expect(handlePreviewOpen({ idempotencyKey: "k1", port: 3000 }, deps)).rejects.toThrow(
        "max-tunnels-reached",
      );
      expect(spawnImpl).not.toHaveBeenCalled();
    });

    it("returns the existing tunnel for a port that already has one, without spawning again", async () => {
      const child = new FakeChild(4242);
      const spawnImpl: SpawnFn = vi.fn(() => {
        queueMicrotask(() => {
          child.stderr.emit("data", Buffer.from("https://already-open.trycloudflare.com\n"));
        });
        return child as never;
      });
      const deps = baseDeps({ spawnImpl });

      const first = await handlePreviewOpen({ idempotencyKey: "k1", port: 3000 }, deps);
      const second = await handlePreviewOpen({ idempotencyKey: "k2", port: 3000 }, deps);

      expect(second).toEqual(first);
      expect(spawnImpl).toHaveBeenCalledTimes(1);
    });

    it("times out, kills the child, and rejects with a stderr tail", async () => {
      const child = new FakeChild(4242);
      const spawnImpl: SpawnFn = vi.fn(() => {
        queueMicrotask(() => {
          child.stderr.emit("data", Buffer.from("still starting up...\n"));
        });
        return child as never;
      });
      const deps = baseDeps({ spawnImpl, urlTimeoutMs: 20 });

      await expect(handlePreviewOpen({ idempotencyKey: "k1", port: 3000 }, deps)).rejects.toThrow(
        /timed out.*stderr tail.*still starting up/s,
      );
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(deps.registry.list()).toEqual([]);
    });

    it("rejects and cleans the journal when the child exits before a URL appears", async () => {
      const child = new FakeChild(4242);
      const spawnImpl: SpawnFn = vi.fn(() => {
        queueMicrotask(() => {
          child.stderr.emit("data", Buffer.from("fatal error: could not connect\n"));
          child.emit("exit", 1);
        });
        return child as never;
      });
      const deps = baseDeps({ spawnImpl });

      await expect(handlePreviewOpen({ idempotencyKey: "k1", port: 3000 }, deps)).rejects.toThrow(
        /cloudflared exited.*could not connect/s,
      );
      expect(deps.registry.list()).toEqual([]);
      expect(await readTunnelJournal(homeDir)).toEqual([]);
    });

    it("rejects when the spawn itself errors (e.g. ENOENT)", async () => {
      const child = new FakeChild(4242);
      const spawnImpl: SpawnFn = vi.fn(() => {
        queueMicrotask(() => {
          child.emit(
            "error",
            Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" }),
          );
        });
        return child as never;
      });
      const deps = baseDeps({ spawnImpl });

      await expect(handlePreviewOpen({ idempotencyKey: "k1", port: 3000 }, deps)).rejects.toThrow(
        "failed to spawn cloudflared: spawn cloudflared ENOENT",
      );
    });

    it("self-cleans the registry + journal when the child exits spontaneously after success", async () => {
      const child = new FakeChild(4242);
      const spawnImpl: SpawnFn = vi.fn(() => {
        queueMicrotask(() => {
          child.stderr.emit("data", Buffer.from("https://alive-for-now.trycloudflare.com\n"));
        });
        return child as never;
      });
      const deps = baseDeps({ spawnImpl });

      await handlePreviewOpen({ idempotencyKey: "k1", port: 3000 }, deps);
      expect(deps.registry.list()).toHaveLength(1);

      child.emit("exit", 0);
      // Registry mutation from the 'exit' listener happens synchronously;
      // the journal removal it also fires is fire-and-forget (nothing left
      // to resolve/reject at this point), so give it a tick to settle
      // before this test's own homeDir gets torn down in `afterEach`.
      expect(deps.registry.list()).toEqual([]);
      await new Promise((r) => setTimeout(r, 20));
    });
  });

  describe("handlePreviewTunnels", () => {
    it("maps the registry to the wire shape, without the child handle", async () => {
      const registry = createTunnelRegistry();
      registry.add({
        tunnelId: "t1",
        port: 3000,
        url: "https://t1.trycloudflare.com",
        pid: 111,
        startedAt: 500,
        status: "active",
        child: new FakeChild(111) as never,
      });
      const deps = baseDeps({ registry });

      await expect(handlePreviewTunnels({ idempotencyKey: "k1" }, deps)).resolves.toEqual({
        tunnels: [
          {
            tunnelId: "t1",
            port: 3000,
            url: "https://t1.trycloudflare.com",
            status: "active",
            startedAt: 500,
          },
        ],
      });
    });
  });

  describe("handlePreviewClose", () => {
    it("is a no-op {ok:true} for an unknown tunnelId", async () => {
      const deps = baseDeps();
      await expect(
        handlePreviewClose({ idempotencyKey: "k1", tunnelId: "does-not-exist" }, deps),
      ).resolves.toEqual({ ok: true });
    });

    it("SIGTERMs then SIGKILLs a stubborn child, then removes it from registry + journal", async () => {
      const registry = createTunnelRegistry();
      registry.add({
        tunnelId: "t1",
        port: 3000,
        url: "https://t1.trycloudflare.com",
        pid: 111,
        startedAt: 500,
        status: "active",
        child: new FakeChild(111) as never,
      });
      await appendJournalEntry(homeDir, { pid: 111, port: 3000, startedAt: 500 });

      let nowValue = 0;
      const isAlive = vi.fn().mockReturnValue(true); // stubborn — never reports dead
      const now = vi.fn(() => {
        nowValue += 1000;
        return nowValue;
      });
      const deps = baseDeps({ registry, isAlive, now, gracefulTimeoutMs: 50 });

      await handlePreviewClose({ idempotencyKey: "k1", tunnelId: "t1" }, deps);

      expect(deps.killPid).toHaveBeenCalledWith(111, "SIGTERM");
      expect(deps.killPid).toHaveBeenCalledWith(111, "SIGKILL");
      expect(registry.get("t1")).toBeUndefined();
      expect(await readTunnelJournal(homeDir)).toEqual([]);
    });

    it("does not SIGKILL a child that exits cleanly after SIGTERM", async () => {
      const registry = createTunnelRegistry();
      registry.add({
        tunnelId: "t2",
        port: 3001,
        url: "https://t2.trycloudflare.com",
        pid: 222,
        startedAt: 500,
        status: "active",
        child: new FakeChild(222) as never,
      });
      const isAlive = vi.fn().mockReturnValue(false); // dies immediately
      const deps = baseDeps({ registry, isAlive });

      await handlePreviewClose({ idempotencyKey: "k1", tunnelId: "t2" }, deps);

      expect(deps.killPid).toHaveBeenCalledWith(222, "SIGTERM");
      expect(deps.killPid).not.toHaveBeenCalledWith(222, "SIGKILL");
    });
  });

  describe("closeAllTunnels", () => {
    it("closes every tracked tunnel in parallel", async () => {
      const registry = createTunnelRegistry();
      registry.add({
        tunnelId: "a",
        port: 3000,
        url: "https://a.trycloudflare.com",
        pid: 1,
        startedAt: 0,
        status: "active",
        child: new FakeChild(1) as never,
      });
      registry.add({
        tunnelId: "b",
        port: 3001,
        url: "https://b.trycloudflare.com",
        pid: 2,
        startedAt: 0,
        status: "active",
        child: new FakeChild(2) as never,
      });
      const isAlive = vi.fn().mockReturnValue(false);
      const deps = baseDeps({ registry, isAlive });

      await closeAllTunnels(deps);

      expect(registry.list()).toEqual([]);
      expect(deps.killPid).toHaveBeenCalledWith(1, "SIGTERM");
      expect(deps.killPid).toHaveBeenCalledWith(2, "SIGTERM");
    });
  });
});
