import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { open, seal } from "@falcon/crypto";
import type {
  AdoptMirrorResult,
  AdoptTakeResult,
  EncryptedBox,
  FsListResult,
  FsMkdirResult,
  PreviewCloseResult,
  PreviewOpenResult,
  PreviewPortsResult,
  PreviewTunnelsResult,
  SpawnParams,
  SpawnResult,
  WorkspaceRegisterResult,
  WorkspaceUnregisterResult,
} from "@falcon/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MACHINE_RPC_METHODS,
  type MachineRpcDeps,
  registerMachineRpcHandlers,
} from "./machineRpc.js";
import { WorkspaceValidationError } from "./workspacePath.js";

/** Minimal fake standing in for a socket.io-client `Socket` (mirrors rpc/sessionRpc.test.ts's FakeSocket). */
class FakeSocket {
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  emitted: { event: string; payload: unknown }[] = [];
  connected = false;

  on(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(
      event,
      list.filter((h) => h !== handler),
    );
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  trigger(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

const DEK = new Uint8Array(32).fill(3);

function spawnParams(overrides: Partial<SpawnParams> = {}): SpawnParams {
  return {
    idempotencyKey: "idem_1",
    workspaceId: "ws_1",
    directory: "/tmp/proj",
    provider: "claude-code",
    permissionMode: "default",
    ...overrides,
  };
}

/** Every `MachineRpcDeps` field besides `machineId`/`dek`/`socket`, defaulted to a never-called `vi.fn()` — individual tests override what they exercise. */
function baseHandlerDeps(): Pick<
  MachineRpcDeps,
  | "spawnSession"
  | "resumeSession"
  | "adoptTake"
  | "adoptMirror"
  | "previewPorts"
  | "previewTunnels"
  | "previewOpen"
  | "previewClose"
> {
  return {
    spawnSession: vi.fn(),
    resumeSession: vi.fn(),
    adoptTake: vi.fn(),
    adoptMirror: vi.fn(),
    previewPorts: vi.fn(),
    previewTunnels: vi.fn(),
    previewOpen: vi.fn(),
    previewClose: vi.fn(),
  };
}

function register(
  socket: FakeSocket,
  overrides: Partial<MachineRpcDeps> = {},
): ReturnType<typeof registerMachineRpcHandlers> {
  return registerMachineRpcHandlers({
    machineId: "mach_1",
    dek: DEK,
    socket: socket as unknown as import("socket.io-client").Socket,
    ...baseHandlerDeps(),
    ...overrides,
  });
}

async function callAndAwaitAck(
  socket: FakeSocket,
  method: string,
  params: unknown,
): Promise<EncryptedBox> {
  return new Promise((resolve) => {
    socket.trigger("rpc-request", { method, params }, (response: EncryptedBox) =>
      resolve(response),
    );
  });
}

describe("registerMachineRpcHandlers", () => {
  it("registers every machine RPC target on connect", () => {
    const socket = new FakeSocket();
    register(socket);

    socket.trigger("connect");

    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:spawn" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:resumeSession" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:fs.list" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:fs.mkdir" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:workspace.register" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:workspace.unregister" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:git.status" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:git.diff" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:git.branches" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:git.commit" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:git.push" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:git.renameBranch" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:git.init" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:git.setRemote" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:github.checks" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:commands.list" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:git.files" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:fs.read" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:provider.account" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:sleepInhibit.get" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:sleepInhibit.set" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:adopt.take" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:adopt.mirror" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:preview.ports" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:preview.tunnels" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:preview.open" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:preview.close" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:workspace.getConfig" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:run.start" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:run.stop" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:run.status" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:run.setup" },
    });
  });

  it("registers immediately if the socket is already connected", () => {
    const socket = new FakeSocket();
    socket.connected = true;
    register(socket);

    expect(socket.emitted).toHaveLength(MACHINE_RPC_METHODS.length);
  });

  describe("spawn", () => {
    it("decrypts params, calls spawnSession, and seals the result", async () => {
      const socket = new FakeSocket();
      const spawnSession = vi.fn(async (): Promise<SpawnResult> => ({ sessionId: "sess_1" }));
      register(socket, { spawnSession });

      const params = spawnParams();
      const response = await callAndAwaitAck(socket, "spawn", seal(params, DEK));

      expect(spawnSession).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ sessionId: "sess_1" });
    });

    it("replays the cached result for a retried idempotencyKey instead of spawning again", async () => {
      const socket = new FakeSocket();
      const spawnSession = vi.fn(async (): Promise<SpawnResult> => ({ sessionId: "sess_1" }));
      register(socket, { spawnSession });

      const params = spawnParams();
      const first = await callAndAwaitAck(socket, "spawn", seal(params, DEK));
      const second = await callAndAwaitAck(socket, "spawn", seal(params, DEK));

      expect(spawnSession).toHaveBeenCalledOnce();
      expect(open(first, DEK)).toEqual({ sessionId: "sess_1" });
      expect(open(second, DEK)).toEqual({ sessionId: "sess_1" });
    });

    it("does NOT cache a failed spawn attempt — a retry re-runs spawnSession", async () => {
      const socket = new FakeSocket();
      const spawnSession = vi
        .fn()
        .mockRejectedValueOnce(new Error("workspace path rejected"))
        .mockResolvedValueOnce({ sessionId: "sess_2" });
      register(socket, { spawnSession });

      const params = spawnParams();
      const first = await callAndAwaitAck(socket, "spawn", seal(params, DEK));
      expect(open(first, DEK)).toEqual({ ok: false, error: "workspace path rejected" });

      const second = await callAndAwaitAck(socket, "spawn", seal(params, DEK));
      expect(spawnSession).toHaveBeenCalledTimes(2);
      expect(open(second, DEK)).toEqual({ sessionId: "sess_2" });
    });

    it("does NOT cache a requiresApproval result — a retry with the same key re-runs spawnSession", async () => {
      const socket = new FakeSocket();
      const spawnSession = vi
        .fn()
        .mockResolvedValueOnce({
          requiresApproval: { action: "create-directory", directory: "/tmp/proj" },
        } satisfies SpawnResult)
        .mockResolvedValueOnce({ sessionId: "sess_3" } satisfies SpawnResult);
      register(socket, { spawnSession });

      const params = spawnParams();
      const first = await callAndAwaitAck(socket, "spawn", seal(params, DEK));
      expect(open(first, DEK)).toEqual({
        requiresApproval: { action: "create-directory", directory: "/tmp/proj" },
      });

      // Same idempotencyKey, retried after the caller created the directory —
      // must actually re-run spawnSession, not replay the stale requiresApproval.
      const second = await callAndAwaitAck(socket, "spawn", seal(params, DEK));
      expect(spawnSession).toHaveBeenCalledTimes(2);
      expect(open(second, DEK)).toEqual({ sessionId: "sess_3" });
    });

    it("collapses two concurrent calls with the same idempotencyKey into a single spawn attempt", async () => {
      // Regression coverage for handleSpawn's in-flight-promise caching (mirrors
      // machineRpc.takeoverRace.test.ts's adopt.take coverage of the same "concurrency,
      // not just retry-after-the-fact" fix, see this module's header comment): two
      // calls arriving back-to-back — before spawnSession has resolved — must collapse
      // into one real spawn, not each see a cache miss and independently spawn.
      const socket = new FakeSocket();
      let resolveSpawn!: (result: SpawnResult) => void;
      const spawnSession = vi.fn(
        () =>
          new Promise<SpawnResult>((resolve) => {
            resolveSpawn = resolve;
          }),
      );
      register(socket, { spawnSession });

      const params = spawnParams();
      const first = callAndAwaitAck(socket, "spawn", seal(params, DEK));
      const second = callAndAwaitAck(socket, "spawn", seal(params, DEK));

      expect(spawnSession).toHaveBeenCalledTimes(1);

      resolveSpawn({ sessionId: "sess_concurrent" });
      const [firstResponse, secondResponse] = await Promise.all([first, second]);

      expect(spawnSession).toHaveBeenCalledTimes(1);
      expect(open(firstResponse, DEK)).toEqual({ sessionId: "sess_concurrent" });
      expect(open(secondResponse, DEK)).toEqual({ sessionId: "sess_concurrent" });
    });

    it("distinguishes idempotency keys — a different key always spawns fresh", async () => {
      const socket = new FakeSocket();
      const spawnSession = vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "sess_a" })
        .mockResolvedValueOnce({ sessionId: "sess_b" });
      register(socket, { spawnSession });

      const a = await callAndAwaitAck(
        socket,
        "spawn",
        seal(spawnParams({ idempotencyKey: "idem_a" }), DEK),
      );
      const b = await callAndAwaitAck(
        socket,
        "spawn",
        seal(spawnParams({ idempotencyKey: "idem_b" }), DEK),
      );

      expect(spawnSession).toHaveBeenCalledTimes(2);
      expect(open(a, DEK)).toEqual({ sessionId: "sess_a" });
      expect(open(b, DEK)).toEqual({ sessionId: "sess_b" });
    });

    it("replies with a sealed error when spawnSession's result fails its own schema", async () => {
      const socket = new FakeSocket();
      register(socket, {
        // `sessionId` is optional on `SpawnResultSchema` (the requiresApproval
        // variant omits it entirely), so a wrong *type* — not just a missing
        // field — is what actually fails validation here.
        spawnSession: vi.fn(async () => ({ sessionId: 42 }) as unknown as SpawnResult),
      });

      const response = await callAndAwaitAck(socket, "spawn", seal(spawnParams(), DEK));
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-result" });
    });

    it("replies with a sealed error when decrypted params fail SpawnParamsSchema", async () => {
      const socket = new FakeSocket();
      register(socket);

      const response = await callAndAwaitAck(
        socket,
        "spawn",
        seal({ provider: "not-a-provider" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });

    it("replies with a sealed error when spawnSession throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        spawnSession: vi.fn(async () => {
          throw new Error("boom");
        }),
      });

      const response = await callAndAwaitAck(socket, "spawn", seal(spawnParams(), DEK));
      expect(open(response, DEK)).toEqual({ ok: false, error: "boom" });
    });
  });

  describe("resumeSession method", () => {
    it("decrypts params, calls resumeSession, and seals a bare {ok:true}", async () => {
      const socket = new FakeSocket();
      const resumeSession = vi.fn(async () => undefined);
      register(socket, { resumeSession });

      const response = await callAndAwaitAck(
        socket,
        "resumeSession",
        seal({ sessionId: "sess_1" }, DEK),
      );

      expect(resumeSession).toHaveBeenCalledExactlyOnceWith("sess_1");
      expect(open(response, DEK)).toEqual({ ok: true });
    });

    it("has no idempotency-key replay — a second call always calls resumeSession again", async () => {
      const socket = new FakeSocket();
      const resumeSession = vi.fn(async () => undefined);
      register(socket, { resumeSession });

      await callAndAwaitAck(socket, "resumeSession", seal({ sessionId: "sess_1" }, DEK));
      await callAndAwaitAck(socket, "resumeSession", seal({ sessionId: "sess_1" }, DEK));

      expect(resumeSession).toHaveBeenCalledTimes(2);
    });

    it("replies with a sealed error when decrypted params fail ResumeSessionParamsSchema", async () => {
      const socket = new FakeSocket();
      register(socket);

      const response = await callAndAwaitAck(socket, "resumeSession", seal({}, DEK));
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });

    it("replies with a sealed error when resumeSession throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        resumeSession: vi.fn(async () => {
          throw new Error("no such session");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "resumeSession",
        seal({ sessionId: "sess_1" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "no such session" });
    });
  });

  describe("fs.list", () => {
    it("decrypts params, calls listDirectory, and seals the result", async () => {
      const socket = new FakeSocket();
      const listDirectory = vi.fn(
        async (): Promise<FsListResult> => ({
          path: "/home/me",
          parent: "/home",
          entries: [{ name: "projects", isDirectory: true }],
        }),
      );
      register(socket, { listDirectory });

      const params = { idempotencyKey: "idem_fs_1", path: "/home/me" };
      const response = await callAndAwaitAck(socket, "fs.list", seal(params, DEK));

      expect(listDirectory).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        path: "/home/me",
        parent: "/home",
        entries: [{ name: "projects", isDirectory: true }],
      });
    });

    it("replies with a sealed error when listDirectory throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        listDirectory: vi.fn(async () => {
          throw new Error("directory not found");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "fs.list",
        seal({ idempotencyKey: "idem_fs_2" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "directory not found" });
    });
  });

  describe("fs.mkdir", () => {
    it("decrypts params, calls createDirectory, and seals the result", async () => {
      const socket = new FakeSocket();
      const createDirectory = vi.fn(async (): Promise<FsMkdirResult> => ({ ok: true }));
      register(socket, { createDirectory });

      const params = { idempotencyKey: "idem_mk_1", path: "/tmp/new-project" };
      const response = await callAndAwaitAck(socket, "fs.mkdir", seal(params, DEK));

      expect(createDirectory).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ ok: true });
    });

    it("replies with a sealed error when params fail schema validation (missing path)", async () => {
      const socket = new FakeSocket();
      register(socket, { createDirectory: vi.fn() });

      const response = await callAndAwaitAck(
        socket,
        "fs.mkdir",
        seal({ idempotencyKey: "idem_mk_2" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });
  });

  describe("workspace.register", () => {
    it("decrypts params, calls registerWorkspace, and seals the result", async () => {
      const socket = new FakeSocket();
      const registerWorkspace = vi.fn(async (): Promise<WorkspaceRegisterResult> => ({ ok: true }));
      register(socket, { registerWorkspace });

      const params = { idempotencyKey: "idem_ws_1", directory: "/tmp/fresh-project" };
      const response = await callAndAwaitAck(socket, "workspace.register", seal(params, DEK));

      expect(registerWorkspace).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ ok: true });
    });

    it("replies with a sealed error when params fail schema validation (missing directory)", async () => {
      const socket = new FakeSocket();
      register(socket, { registerWorkspace: vi.fn() });

      const response = await callAndAwaitAck(
        socket,
        "workspace.register",
        seal({ idempotencyKey: "idem_ws_2" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });

    it("replies with a sealed error when registerWorkspace throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        registerWorkspace: vi.fn(async () => {
          throw new Error("failed to acquire workspace registry lock");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "workspace.register",
        seal({ idempotencyKey: "idem_ws_3", directory: "/tmp/fresh-project" }, DEK),
      );
      expect(open(response, DEK)).toEqual({
        ok: false,
        error: "failed to acquire workspace registry lock",
      });
    });

    describe("with the real default (no mocked-away side effect)", () => {
      // Live-equivalent coverage (plan.md §16 "Flow 3 —
      // spawn-fresh-folder-register (Piece A)" Definition of Done): unlike
      // every other `describe` block above, this one does NOT override
      // `registerWorkspace` in `register(...)` — it exercises
      // `machineRpc.ts`'s real, dependency-free default
      // (`workspaceRegisterRpc.ts`, wrapping `workspace/registry.ts`'s real
      // `registerWorkspace`), pointed at a temp `~/.falcon`-equivalent via
      // `FALCON_HOME_DIR`, and asserts the actual `workspaces.json` file the
      // real registry writes — proving the RPC really performs the durable
      // side effect, not just that some function got called.
      let homeDir: string;
      let previousFalconHomeDir: string | undefined;

      beforeEach(async () => {
        homeDir = await mkdtemp(path.join(tmpdir(), "falcon-workspace-register-rpc-"));
        previousFalconHomeDir = process.env.FALCON_HOME_DIR;
        process.env.FALCON_HOME_DIR = homeDir;
      });

      afterEach(async () => {
        if (previousFalconHomeDir === undefined) delete process.env.FALCON_HOME_DIR;
        else process.env.FALCON_HOME_DIR = previousFalconHomeDir;
        await rm(homeDir, { recursive: true, force: true });
      });

      it("actually writes a real workspaces.json entry via the real registerWorkspace", async () => {
        const socket = new FakeSocket();
        register(socket); // no registerWorkspace override — exercises the real default

        const target = path.join(homeDir, "project");
        const response = await callAndAwaitAck(
          socket,
          "workspace.register",
          seal({ idempotencyKey: "idem_ws_live_1", directory: target }, DEK),
        );
        expect(open(response, DEK)).toEqual({ ok: true });

        const written = JSON.parse(await readFile(path.join(homeDir, "workspaces.json"), "utf8"));
        expect(written.workspaces).toContainEqual(expect.objectContaining({ path: target }));
      });
    });
  });

  describe("workspace.unregister", () => {
    it("decrypts params, calls unregisterWorkspace, and seals the result", async () => {
      const socket = new FakeSocket();
      const unregisterWorkspace = vi.fn(
        async (): Promise<WorkspaceUnregisterResult> => ({ ok: true }),
      );
      register(socket, { unregisterWorkspace });

      const params = { idempotencyKey: "idem_ws_un_1", directory: "/tmp/stale-project" };
      const response = await callAndAwaitAck(socket, "workspace.unregister", seal(params, DEK));

      expect(unregisterWorkspace).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ ok: true });
    });

    it("replies with a sealed error when params fail schema validation (missing directory)", async () => {
      const socket = new FakeSocket();
      register(socket, { unregisterWorkspace: vi.fn() });

      const response = await callAndAwaitAck(
        socket,
        "workspace.unregister",
        seal({ idempotencyKey: "idem_ws_un_2" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });

    describe("with the real default (no mocked-away side effect)", () => {
      let homeDir: string;
      let previousFalconHomeDir: string | undefined;

      beforeEach(async () => {
        homeDir = await mkdtemp(path.join(tmpdir(), "falcon-workspace-unregister-rpc-"));
        previousFalconHomeDir = process.env.FALCON_HOME_DIR;
        process.env.FALCON_HOME_DIR = homeDir;
      });

      afterEach(async () => {
        if (previousFalconHomeDir === undefined) delete process.env.FALCON_HOME_DIR;
        else process.env.FALCON_HOME_DIR = previousFalconHomeDir;
        await rm(homeDir, { recursive: true, force: true });
      });

      it("actually removes a real workspaces.json entry via the real unregisterWorkspace", async () => {
        const socket = new FakeSocket();
        register(socket); // no registerWorkspace/unregisterWorkspace override — exercises the real defaults

        const target = path.join(homeDir, "project");
        await callAndAwaitAck(
          socket,
          "workspace.register",
          seal({ idempotencyKey: "idem_ws_un_live_1", directory: target }, DEK),
        );

        const response = await callAndAwaitAck(
          socket,
          "workspace.unregister",
          seal({ idempotencyKey: "idem_ws_un_live_2", directory: target }, DEK),
        );
        expect(open(response, DEK)).toEqual({ ok: true });

        const written = JSON.parse(await readFile(path.join(homeDir, "workspaces.json"), "utf8"));
        expect(written.workspaces).not.toContainEqual(expect.objectContaining({ path: target }));
      });
    });
  });

  describe("git.status", () => {
    it("decrypts params, calls getGitStatus, and seals the result", async () => {
      const socket = new FakeSocket();
      const getGitStatus = vi.fn(async () => ({
        branch: "main",
        ahead: 1,
        behind: 0,
        files: [{ path: "src/a.ts", status: "modified" as const }],
      }));
      register(socket, { getGitStatus });

      const params = { idempotencyKey: "idem_git_status_1", worktree: "/repo" };
      const response = await callAndAwaitAck(socket, "git.status", seal(params, DEK));

      expect(getGitStatus).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        branch: "main",
        ahead: 1,
        behind: 0,
        files: [{ path: "src/a.ts", status: "modified" }],
      });
    });

    it("replies with a sealed error when getGitStatus throws (e.g. not a git repo)", async () => {
      const socket = new FakeSocket();
      register(socket, {
        getGitStatus: vi.fn(async () => {
          throw new Error("fatal: not a git repository");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "git.status",
        seal({ idempotencyKey: "idem_git_status_2", worktree: "/repo" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "fatal: not a git repository" });
    });

    it("attaches the typed .code when getGitStatus throws a WorkspaceValidationError (known-issues.md #3)", async () => {
      const socket = new FakeSocket();
      register(socket, {
        getGitStatus: vi.fn(async () => {
          throw new WorkspaceValidationError(
            "workspace directory not found: /gone",
            "workspace-missing",
          );
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "git.status",
        seal({ idempotencyKey: "idem_git_status_3", worktree: "/gone" }, DEK),
      );
      expect(open(response, DEK)).toEqual({
        ok: false,
        error: "workspace directory not found: /gone",
        code: "workspace-missing",
      });
    });
  });

  describe("git.diff", () => {
    it("decrypts params, calls getGitDiff, and seals the result", async () => {
      const socket = new FakeSocket();
      const getGitDiff = vi.fn(async () => ({
        inline: "diff --git a/x b/x",
        truncated: false,
      }));
      register(socket, { getGitDiff });

      const params = { idempotencyKey: "idem_git_diff_1", worktree: "/repo", baseRef: "main" };
      const response = await callAndAwaitAck(socket, "git.diff", seal(params, DEK));

      expect(getGitDiff).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ inline: "diff --git a/x b/x", truncated: false });
    });

    it("replies with a sealed error when params fail schema validation (missing worktree)", async () => {
      const socket = new FakeSocket();
      register(socket, { getGitDiff: vi.fn() });

      const response = await callAndAwaitAck(
        socket,
        "git.diff",
        seal({ idempotencyKey: "idem_git_diff_2" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });
  });

  describe("git.branches", () => {
    it("decrypts params, calls getGitBranches, and seals the result", async () => {
      const socket = new FakeSocket();
      const getGitBranches = vi.fn(async () => ({
        branches: [
          { name: "main", isCurrent: true },
          { name: "wf/foo", isCurrent: false, checkedOutAt: "/repo/.worktrees/wf/foo" },
        ],
      }));
      register(socket, { getGitBranches });

      const params = { idempotencyKey: "idem_git_branches_1", worktree: "/repo" };
      const response = await callAndAwaitAck(socket, "git.branches", seal(params, DEK));

      expect(getGitBranches).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        branches: [
          { name: "main", isCurrent: true },
          { name: "wf/foo", isCurrent: false, checkedOutAt: "/repo/.worktrees/wf/foo" },
        ],
      });
    });

    it("replies with a sealed error when getGitBranches throws (e.g. not a git repo)", async () => {
      const socket = new FakeSocket();
      register(socket, {
        getGitBranches: vi.fn(async () => {
          throw new Error("fatal: not a git repository");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "git.branches",
        seal({ idempotencyKey: "idem_git_branches_2", worktree: "/repo" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "fatal: not a git repository" });
    });
  });

  describe("git.commit", () => {
    it("decrypts params, calls gitCommit, and seals the result", async () => {
      const socket = new FakeSocket();
      const gitCommit = vi.fn(async () => ({ committed: true, commitSha: "abc1234" }));
      register(socket, { gitCommit });

      const params = { idempotencyKey: "idem_git_commit_1", worktree: "/repo", message: "fix" };
      const response = await callAndAwaitAck(socket, "git.commit", seal(params, DEK));

      expect(gitCommit).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ committed: true, commitSha: "abc1234" });
    });

    it("replies with a sealed error when gitCommit throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        gitCommit: vi.fn(async () => {
          throw new Error("fatal: not a git repository");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "git.commit",
        seal({ idempotencyKey: "idem_git_commit_2", worktree: "/repo", message: "fix" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "fatal: not a git repository" });
    });

    it("replays the cached result for a retried idempotencyKey instead of committing again", async () => {
      const socket = new FakeSocket();
      const gitCommit = vi.fn(async () => ({ committed: true, commitSha: "abc1234" }));
      register(socket, { gitCommit });

      const params = { idempotencyKey: "idem_git_commit_3", worktree: "/repo", message: "fix" };
      const first = await callAndAwaitAck(socket, "git.commit", seal(params, DEK));
      const second = await callAndAwaitAck(socket, "git.commit", seal(params, DEK));

      expect(gitCommit).toHaveBeenCalledOnce();
      expect(open(first, DEK)).toEqual({ committed: true, commitSha: "abc1234" });
      expect(open(second, DEK)).toEqual({ committed: true, commitSha: "abc1234" });
    });

    it("does NOT cache a rejected attempt — a retry re-runs gitCommit", async () => {
      const socket = new FakeSocket();
      const gitCommit = vi
        .fn()
        .mockRejectedValueOnce(new Error("fatal: unable to write commit object"))
        .mockResolvedValueOnce({ committed: true, commitSha: "def5678" });
      register(socket, { gitCommit });

      const params = { idempotencyKey: "idem_git_commit_4", worktree: "/repo", message: "fix" };
      const first = await callAndAwaitAck(socket, "git.commit", seal(params, DEK));
      expect(open(first, DEK)).toEqual({
        ok: false,
        error: "fatal: unable to write commit object",
      });

      const second = await callAndAwaitAck(socket, "git.commit", seal(params, DEK));
      expect(gitCommit).toHaveBeenCalledTimes(2);
      expect(open(second, DEK)).toEqual({ committed: true, commitSha: "def5678" });
    });

    it("re-runs gitCommit for the same idempotencyKey with different params", async () => {
      const socket = new FakeSocket();
      const gitCommit = vi
        .fn()
        .mockResolvedValueOnce({ committed: true, commitSha: "aaa1111" })
        .mockResolvedValueOnce({ committed: true, commitSha: "bbb2222" });
      register(socket, { gitCommit });

      const key = "idem_git_commit_5";
      const first = await callAndAwaitAck(
        socket,
        "git.commit",
        seal({ idempotencyKey: key, worktree: "/repo", message: "first" }, DEK),
      );
      const second = await callAndAwaitAck(
        socket,
        "git.commit",
        seal({ idempotencyKey: key, worktree: "/repo", message: "second" }, DEK),
      );

      expect(gitCommit).toHaveBeenCalledTimes(2);
      expect(open(first, DEK)).toEqual({ committed: true, commitSha: "aaa1111" });
      expect(open(second, DEK)).toEqual({ committed: true, commitSha: "bbb2222" });
    });
  });

  describe("git.push", () => {
    it("decrypts params, calls gitPush, and seals the result", async () => {
      const socket = new FakeSocket();
      const gitPush = vi.fn(async () => ({
        ok: true as const,
        remote: "origin",
        branch: "main",
        forced: false,
      }));
      register(socket, { gitPush });

      const params = { idempotencyKey: "idem_git_push_1", worktree: "/repo" };
      const response = await callAndAwaitAck(socket, "git.push", seal(params, DEK));

      expect(gitPush).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        ok: true,
        remote: "origin",
        branch: "main",
        forced: false,
      });
    });

    it("replies with a sealed error when gitPush throws (e.g. no credentials configured)", async () => {
      const socket = new FakeSocket();
      register(socket, {
        gitPush: vi.fn(async () => {
          throw new Error("fatal: could not read Username");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "git.push",
        seal({ idempotencyKey: "idem_git_push_2", worktree: "/repo" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "fatal: could not read Username" });
    });

    it("replays the cached result for a retried idempotencyKey instead of pushing again", async () => {
      const socket = new FakeSocket();
      const gitPush = vi.fn(async () => ({
        ok: true as const,
        remote: "origin",
        branch: "main",
        forced: true,
      }));
      register(socket, { gitPush });

      const params = { idempotencyKey: "idem_git_push_3", worktree: "/repo", force: true };
      const first = await callAndAwaitAck(socket, "git.push", seal(params, DEK));
      const second = await callAndAwaitAck(socket, "git.push", seal(params, DEK));

      expect(gitPush).toHaveBeenCalledOnce();
      expect(open(first, DEK)).toEqual(open(second, DEK));
    });
  });

  describe("git.renameBranch", () => {
    it("decrypts params, calls gitRenameBranch, and seals the result", async () => {
      const socket = new FakeSocket();
      const gitRenameBranch = vi.fn(async () => ({
        ok: true as const,
        branch: "renamed",
        hadUpstream: true,
      }));
      register(socket, { gitRenameBranch });

      const params = { idempotencyKey: "idem_git_rename_1", worktree: "/repo", to: "renamed" };
      const response = await callAndAwaitAck(socket, "git.renameBranch", seal(params, DEK));

      expect(gitRenameBranch).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ ok: true, branch: "renamed", hadUpstream: true });
    });

    it("replies with a sealed error when gitRenameBranch throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        gitRenameBranch: vi.fn(async () => {
          throw new Error("fatal: a branch named 'renamed' already exists");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "git.renameBranch",
        seal({ idempotencyKey: "idem_git_rename_2", worktree: "/repo", to: "renamed" }, DEK),
      );
      expect(open(response, DEK)).toEqual({
        ok: false,
        error: "fatal: a branch named 'renamed' already exists",
      });
    });

    it("replays the cached result for a retried idempotencyKey instead of renaming again", async () => {
      const socket = new FakeSocket();
      const gitRenameBranch = vi.fn(async () => ({
        ok: true as const,
        branch: "renamed",
        hadUpstream: false,
      }));
      register(socket, { gitRenameBranch });

      const params = { idempotencyKey: "idem_git_rename_3", worktree: "/repo", to: "renamed" };
      const first = await callAndAwaitAck(socket, "git.renameBranch", seal(params, DEK));
      const second = await callAndAwaitAck(socket, "git.renameBranch", seal(params, DEK));

      expect(gitRenameBranch).toHaveBeenCalledOnce();
      expect(open(first, DEK)).toEqual(open(second, DEK));
    });
  });

  describe("git.init", () => {
    it("decrypts params, calls gitInit, and seals the result", async () => {
      const socket = new FakeSocket();
      const gitInit = vi.fn(async () => ({ state: "initialized" as const, branch: "main" }));
      register(socket, { gitInit });

      const params = { idempotencyKey: "idem_git_init_1", worktree: "/repo" };
      const response = await callAndAwaitAck(socket, "git.init", seal(params, DEK));

      expect(gitInit).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ state: "initialized", branch: "main" });
    });

    it("replies with a sealed error when gitInit throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        gitInit: vi.fn(async () => {
          throw new Error("fatal: permission denied");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "git.init",
        seal({ idempotencyKey: "idem_git_init_2", worktree: "/repo" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "fatal: permission denied" });
    });

    it("replies with a sealed invalid-params error when worktree is missing", async () => {
      const socket = new FakeSocket();
      register(socket, { gitInit: vi.fn() });

      const response = await callAndAwaitAck(
        socket,
        "git.init",
        seal({ idempotencyKey: "idem_git_init_3" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });

    it("replays the cached result for a retried idempotencyKey instead of initializing again", async () => {
      const socket = new FakeSocket();
      const gitInit = vi.fn(async () => ({ state: "initialized" as const, branch: "main" }));
      register(socket, { gitInit });

      const params = { idempotencyKey: "idem_git_init_4", worktree: "/repo" };
      const first = await callAndAwaitAck(socket, "git.init", seal(params, DEK));
      const second = await callAndAwaitAck(socket, "git.init", seal(params, DEK));

      expect(gitInit).toHaveBeenCalledOnce();
      expect(open(first, DEK)).toEqual(open(second, DEK));
    });

    it("does NOT cache a rejected attempt — a retry re-runs gitInit", async () => {
      const socket = new FakeSocket();
      const gitInit = vi
        .fn()
        .mockRejectedValueOnce(new Error("fatal: permission denied"))
        .mockResolvedValueOnce({ state: "initialized" as const, branch: "main" });
      register(socket, { gitInit });

      const params = { idempotencyKey: "idem_git_init_5", worktree: "/repo" };
      const first = await callAndAwaitAck(socket, "git.init", seal(params, DEK));
      expect(open(first, DEK)).toEqual({ ok: false, error: "fatal: permission denied" });

      const second = await callAndAwaitAck(socket, "git.init", seal(params, DEK));
      expect(gitInit).toHaveBeenCalledTimes(2);
      expect(open(second, DEK)).toEqual({ state: "initialized", branch: "main" });
    });

    it("collapses two concurrent calls with DIFFERENT idempotencyKeys for the SAME worktree into a single init attempt", async () => {
      const socket = new FakeSocket();
      let resolveGitInit!: (value: { state: "initialized"; branch: string }) => void;
      const gitInit = vi.fn(
        () =>
          new Promise<{ state: "initialized"; branch: string }>((resolve) => {
            resolveGitInit = resolve;
          }),
      );
      register(socket, { gitInit });

      const fromDeviceA = { idempotencyKey: "idem_git_init_device_a", worktree: "/repo" };
      const fromDeviceB = { idempotencyKey: "idem_git_init_device_b", worktree: "/repo" };

      const responseA = callAndAwaitAck(socket, "git.init", seal(fromDeviceA, DEK));
      const responseB = callAndAwaitAck(socket, "git.init", seal(fromDeviceB, DEK));

      expect(gitInit).toHaveBeenCalledTimes(1);
      expect(gitInit).toHaveBeenCalledWith(fromDeviceA);

      resolveGitInit({ state: "initialized", branch: "main" });
      const [resultA, resultB] = await Promise.all([responseA, responseB]);

      expect(open(resultA, DEK)).toEqual({ state: "initialized", branch: "main" });
      expect(open(resultB, DEK)).toEqual({ state: "initialized", branch: "main" });
      expect(gitInit).toHaveBeenCalledTimes(1);
    });

    describe("with the real default (no mocked-away side effect)", () => {
      let homeDir: string;
      let previousFalconHomeDir: string | undefined;

      beforeEach(async () => {
        homeDir = await mkdtemp(path.join(tmpdir(), "falcon-git-init-rpc-"));
        previousFalconHomeDir = process.env.FALCON_HOME_DIR;
        process.env.FALCON_HOME_DIR = homeDir;
      });

      afterEach(async () => {
        if (previousFalconHomeDir === undefined) delete process.env.FALCON_HOME_DIR;
        else process.env.FALCON_HOME_DIR = previousFalconHomeDir;
        await rm(homeDir, { recursive: true, force: true });
      });

      it("actually creates a real .git directory via the real handleGitInit, for a registered workspace", async () => {
        const socket = new FakeSocket();
        register(socket); // no gitInit/registerWorkspace override — exercises the real defaults

        const target = path.join(homeDir, "project");
        await mkdir(target, { recursive: true });

        const registerResponse = await callAndAwaitAck(
          socket,
          "workspace.register",
          seal({ idempotencyKey: "idem_git_init_live_register", directory: target }, DEK),
        );
        expect(open(registerResponse, DEK)).toEqual({ ok: true });

        const response = await callAndAwaitAck(
          socket,
          "git.init",
          seal({ idempotencyKey: "idem_git_init_live_1", worktree: target }, DEK),
        );
        expect(open(response, DEK)).toMatchObject({ state: "initialized" });

        const gitDirStat = await stat(path.join(target, ".git"));
        expect(gitDirStat.isDirectory()).toBe(true);
      });
    });
  });

  describe("git.setRemote", () => {
    it("decrypts params, calls gitSetRemote, and seals the result", async () => {
      const socket = new FakeSocket();
      const gitSetRemote = vi.fn(async () => ({
        ok: true as const,
        name: "origin",
        url: "git@github.com:a/b.git",
        created: true,
      }));
      register(socket, { gitSetRemote });

      const params = {
        idempotencyKey: "idem_git_set_remote_1",
        worktree: "/repo",
        url: "git@github.com:a/b.git",
      };
      const response = await callAndAwaitAck(socket, "git.setRemote", seal(params, DEK));

      expect(gitSetRemote).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        ok: true,
        name: "origin",
        url: "git@github.com:a/b.git",
        created: true,
      });
    });

    it("replies with a sealed error when gitSetRemote throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        gitSetRemote: vi.fn(async () => {
          throw new Error("unsafe remote url: --upload-pack=evil");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "git.setRemote",
        seal(
          {
            idempotencyKey: "idem_git_set_remote_2",
            worktree: "/repo",
            url: "--upload-pack=evil",
          },
          DEK,
        ),
      );
      expect(open(response, DEK)).toEqual({
        ok: false,
        error: "unsafe remote url: --upload-pack=evil",
      });
    });

    it("replies with a sealed invalid-params error when url is missing", async () => {
      const socket = new FakeSocket();
      register(socket, { gitSetRemote: vi.fn() });

      const response = await callAndAwaitAck(
        socket,
        "git.setRemote",
        seal({ idempotencyKey: "idem_git_set_remote_3", worktree: "/repo" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });

    it("replays the cached result for a retried idempotencyKey instead of setting the remote again", async () => {
      const socket = new FakeSocket();
      const gitSetRemote = vi.fn(async () => ({
        ok: true as const,
        name: "origin",
        url: "git@github.com:a/b.git",
        created: true,
      }));
      register(socket, { gitSetRemote });

      const params = {
        idempotencyKey: "idem_git_set_remote_4",
        worktree: "/repo",
        url: "git@github.com:a/b.git",
      };
      const first = await callAndAwaitAck(socket, "git.setRemote", seal(params, DEK));
      const second = await callAndAwaitAck(socket, "git.setRemote", seal(params, DEK));

      expect(gitSetRemote).toHaveBeenCalledOnce();
      expect(open(first, DEK)).toEqual(open(second, DEK));
    });

    it("does NOT cache a rejected attempt — a retry re-runs gitSetRemote", async () => {
      const socket = new FakeSocket();
      const gitSetRemote = vi
        .fn()
        .mockRejectedValueOnce(new Error("fatal: unable to access remote"))
        .mockResolvedValueOnce({
          ok: true as const,
          name: "origin",
          url: "git@github.com:a/b.git",
          created: true,
        });
      register(socket, { gitSetRemote });

      const params = {
        idempotencyKey: "idem_git_set_remote_5",
        worktree: "/repo",
        url: "git@github.com:a/b.git",
      };
      const first = await callAndAwaitAck(socket, "git.setRemote", seal(params, DEK));
      expect(open(first, DEK)).toEqual({ ok: false, error: "fatal: unable to access remote" });

      const second = await callAndAwaitAck(socket, "git.setRemote", seal(params, DEK));
      expect(gitSetRemote).toHaveBeenCalledTimes(2);
      expect(open(second, DEK)).toEqual({
        ok: true,
        name: "origin",
        url: "git@github.com:a/b.git",
        created: true,
      });
    });
  });

  describe("github.checks", () => {
    it("decrypts params, calls getGithubChecks, and seals the result", async () => {
      const socket = new FakeSocket();
      const getGithubChecks = vi.fn(async () => ({ state: "no-token" as const }));
      register(socket, { getGithubChecks });

      const params = { idempotencyKey: "idem_github_checks_1", worktree: "/repo" };
      const response = await callAndAwaitAck(socket, "github.checks", seal(params, DEK));

      expect(getGithubChecks).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ state: "no-token" });
    });

    it("replies with a sealed error when getGithubChecks throws (e.g. a GitHub API 500)", async () => {
      const socket = new FakeSocket();
      register(socket, {
        getGithubChecks: vi.fn(async () => {
          throw new Error("GitHub API request failed: HTTP 500");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "github.checks",
        seal({ idempotencyKey: "idem_github_checks_2", worktree: "/repo" }, DEK),
      );
      // The shared `onRpcRequest` catch clause forwards the handler's own
      // thrown message (see this module's doc comment / `git.commit`'s
      // sibling test above) rather than a flat "handler-error" placeholder —
      // this test predates that change (docs/features/git-write-actions.md),
      // so it's updated to match the now-current, strictly more useful
      // behavior every handler shares.
      expect(open(response, DEK)).toEqual({
        ok: false,
        error: "GitHub API request failed: HTTP 500",
      });
    });
  });

  describe("commands.list", () => {
    it("decrypts params, calls listSlashCommands, and seals the result", async () => {
      const socket = new FakeSocket();
      const listSlashCommands = vi.fn(async () => ({
        commands: [{ name: "compact" }, { name: "git:commit", description: "Create a commit" }],
      }));
      register(socket, { listSlashCommands });

      const params = { idempotencyKey: "idem_commands_1", worktree: "/repo" };
      const response = await callAndAwaitAck(socket, "commands.list", seal(params, DEK));

      expect(listSlashCommands).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        commands: [{ name: "compact" }, { name: "git:commit", description: "Create a commit" }],
      });
    });

    it("replies with a sealed error when listSlashCommands throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        listSlashCommands: vi.fn(async () => {
          throw new Error("boom");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "commands.list",
        seal({ idempotencyKey: "idem_commands_2", worktree: "/repo" }, DEK),
      );
      // The shared `onRpcRequest` catch clause forwards the handler's own
      // thrown message (see this module's doc comment / `git.commit`'s
      // sibling test above) rather than a flat "handler-error" placeholder —
      // this test predates that change (docs/features/git-write-actions.md),
      // so it's updated to match the now-current, strictly more useful
      // behavior every handler shares.
      expect(open(response, DEK)).toEqual({ ok: false, error: "boom" });
    });
  });

  describe("git.files", () => {
    it("decrypts params, calls getGitFiles, and seals the result", async () => {
      const socket = new FakeSocket();
      const getGitFiles = vi.fn(async () => ({ files: ["README.md", "src/a.ts"] }));
      register(socket, { getGitFiles });

      const params = { idempotencyKey: "idem_git_files_1", worktree: "/repo" };
      const response = await callAndAwaitAck(socket, "git.files", seal(params, DEK));

      expect(getGitFiles).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ files: ["README.md", "src/a.ts"] });
    });

    it("replies with a sealed error when getGitFiles throws (e.g. not a git repo)", async () => {
      const socket = new FakeSocket();
      register(socket, {
        getGitFiles: vi.fn(async () => {
          throw new Error("fatal: not a git repository");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "git.files",
        seal({ idempotencyKey: "idem_git_files_2", worktree: "/repo" }, DEK),
      );
      // The shared `onRpcRequest` catch clause forwards the handler's own
      // thrown message (see this module's doc comment / `git.commit`'s
      // sibling test above) rather than a flat "handler-error" placeholder —
      // this test predates that change (docs/features/git-write-actions.md),
      // so it's updated to match the now-current, strictly more useful
      // behavior every handler shares.
      expect(open(response, DEK)).toEqual({
        ok: false,
        error: "fatal: not a git repository",
      });
    });
  });

  describe("fs.read", () => {
    it("decrypts params, calls readFile, and seals the result", async () => {
      const socket = new FakeSocket();
      const readFileHandler = vi.fn(async () => ({ inline: "const a = 1;\n", truncated: false }));
      register(socket, { readFile: readFileHandler });

      const params = { idempotencyKey: "idem_fs_read_1", worktree: "/repo", path: "src/a.ts" };
      const response = await callAndAwaitAck(socket, "fs.read", seal(params, DEK));

      expect(readFileHandler).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ inline: "const a = 1;\n", truncated: false });
    });

    it("replies with a sealed error when readFile throws (e.g. binary/missing file)", async () => {
      const socket = new FakeSocket();
      register(socket, {
        readFile: vi.fn(async () => {
          throw new Error("looks like a binary file");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "fs.read",
        seal({ idempotencyKey: "idem_fs_read_2", worktree: "/repo", path: "img.png" }, DEK),
      );
      // The shared `onRpcRequest` catch clause forwards the handler's own
      // thrown message (see this module's doc comment / `git.commit`'s
      // sibling test above) rather than a flat "handler-error" placeholder —
      // this test predates that change (docs/features/git-write-actions.md),
      // so it's updated to match the now-current, strictly more useful
      // behavior every handler shares.
      expect(open(response, DEK)).toEqual({
        ok: false,
        error: "looks like a binary file",
      });
    });
  });

  describe("provider.account", () => {
    it("decrypts params, calls getProviderAccountInfo, and seals the result", async () => {
      const socket = new FakeSocket();
      const getProviderAccountInfo = vi.fn(async () => ({
        provider: "claude-code" as const,
        authenticated: true,
        authType: "oauth",
        email: "dev@example.com",
        organization: "Acme Org",
        organizationRole: "admin",
        billingType: "stripe_subscription",
        lastRefreshedAt: 1_700_000_000_000,
        usage: [{ label: "Weekly", percentUsed: 93, resetsAt: "2026-07-20T18:00:00.000Z" }],
      }));
      register(socket, { getProviderAccountInfo });

      const params = {
        idempotencyKey: "idem_provider_account_1",
        provider: "claude-code" as const,
      };
      const response = await callAndAwaitAck(socket, "provider.account", seal(params, DEK));

      expect(getProviderAccountInfo).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        provider: "claude-code",
        authenticated: true,
        authType: "oauth",
        email: "dev@example.com",
        organization: "Acme Org",
        organizationRole: "admin",
        billingType: "stripe_subscription",
        lastRefreshedAt: 1_700_000_000_000,
        usage: [{ label: "Weekly", percentUsed: 93, resetsAt: "2026-07-20T18:00:00.000Z" }],
      });
    });

    it("replies with a sealed error when getProviderAccountInfo throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        getProviderAccountInfo: vi.fn(async () => {
          throw new Error("unexpected failure");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "provider.account",
        seal({ idempotencyKey: "idem_provider_account_2", provider: "codex" as const }, DEK),
      );
      // The shared `onRpcRequest` catch clause forwards the handler's own
      // thrown message (see this module's doc comment / `git.commit`'s
      // sibling test above) rather than a flat "handler-error" placeholder —
      // this test predates that change (docs/features/git-write-actions.md),
      // so it's updated to match the now-current, strictly more useful
      // behavior every handler shares.
      expect(open(response, DEK)).toEqual({
        ok: false,
        error: "unexpected failure",
      });
    });
  });

  describe("sleepInhibit.get / sleepInhibit.set (docs/features/sleep-inhibit.md)", () => {
    it("sleepInhibit.get decrypts params, calls getSleepInhibit, and seals the result", async () => {
      const socket = new FakeSocket();
      const getSleepInhibit = vi.fn(async () => ({
        supported: true,
        platform: "darwin",
        mode: "always" as const,
        active: true,
      }));
      register(socket, { getSleepInhibit });

      const params = { idempotencyKey: "idem_sleep_get_1" };
      const response = await callAndAwaitAck(socket, "sleepInhibit.get", seal(params, DEK));

      expect(getSleepInhibit).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        supported: true,
        platform: "darwin",
        mode: "always",
        active: true,
      });
    });

    it("sleepInhibit.set decrypts params, calls setSleepInhibit, and seals the result", async () => {
      const socket = new FakeSocket();
      const setSleepInhibit = vi.fn(async () => ({
        supported: true,
        platform: "darwin",
        mode: "onPower" as const,
        active: true,
      }));
      register(socket, { setSleepInhibit });

      const params = { idempotencyKey: "idem_sleep_set_1", mode: "onPower" as const };
      const response = await callAndAwaitAck(socket, "sleepInhibit.set", seal(params, DEK));

      expect(setSleepInhibit).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        supported: true,
        platform: "darwin",
        mode: "onPower",
        active: true,
      });
    });

    it("rejects an invalid mode via schema validation before the handler ever runs", async () => {
      const socket = new FakeSocket();
      const setSleepInhibit = vi.fn();
      register(socket, { setSleepInhibit });

      const response = await callAndAwaitAck(
        socket,
        "sleepInhibit.set",
        seal({ idempotencyKey: "idem_sleep_set_2", mode: "forever" }, DEK),
      );

      expect(setSleepInhibit).not.toHaveBeenCalled();
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });

    it("defaults to an honest unsupported stub when no manager is wired", async () => {
      const socket = new FakeSocket();
      register(socket); // no getSleepInhibit/setSleepInhibit override

      const getResponse = await callAndAwaitAck(
        socket,
        "sleepInhibit.get",
        seal({ idempotencyKey: "idem_sleep_get_2" }, DEK),
      );
      expect(open(getResponse, DEK)).toEqual({
        supported: false,
        platform: process.platform,
        mode: "off",
        active: false,
      });

      const setResponse = await callAndAwaitAck(
        socket,
        "sleepInhibit.set",
        seal({ idempotencyKey: "idem_sleep_set_3", mode: "always" }, DEK),
      );
      expect(open(setResponse, DEK)).toEqual({
        supported: false,
        platform: process.platform,
        mode: "off",
        active: false,
      });
    });
  });

  describe("adopt.take", () => {
    function adoptTakeParams(overrides: Record<string, unknown> = {}) {
      return {
        idempotencyKey: "idem_take_1",
        providerSessionId: "prov_1",
        mode: "takeover" as const,
        ...overrides,
      };
    }

    it("decrypts params, calls adoptTake, and seals the result", async () => {
      const socket = new FakeSocket();
      const adoptTake = vi.fn(async (): Promise<AdoptTakeResult> => ({ sessionId: "sess_9" }));
      register(socket, { adoptTake });

      const params = adoptTakeParams();
      const response = await callAndAwaitAck(socket, "adopt.take", seal(params, DEK));

      expect(adoptTake).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ sessionId: "sess_9" });
    });

    it("carries an optional mid-turn warning through untouched", async () => {
      const socket = new FakeSocket();
      const adoptTake = vi.fn(
        async (): Promise<AdoptTakeResult> => ({ sessionId: "sess_9", warning: "interrupted" }),
      );
      register(socket, { adoptTake });

      const response = await callAndAwaitAck(socket, "adopt.take", seal(adoptTakeParams(), DEK));
      expect(open(response, DEK)).toEqual({ sessionId: "sess_9", warning: "interrupted" });
    });

    it("replays the cached result for a retried idempotencyKey instead of taking over again", async () => {
      const socket = new FakeSocket();
      const adoptTake = vi.fn(async (): Promise<AdoptTakeResult> => ({ sessionId: "sess_9" }));
      register(socket, { adoptTake });

      const params = adoptTakeParams();
      await callAndAwaitAck(socket, "adopt.take", seal(params, DEK));
      await callAndAwaitAck(socket, "adopt.take", seal(params, DEK));

      expect(adoptTake).toHaveBeenCalledOnce();
    });

    it("does NOT cache a failed adopt.take attempt", async () => {
      const socket = new FakeSocket();
      const adoptTake = vi
        .fn()
        .mockRejectedValueOnce(new Error("no such provider session"))
        .mockResolvedValueOnce({ sessionId: "sess_10" });
      register(socket, { adoptTake });

      const params = adoptTakeParams();
      const first = await callAndAwaitAck(socket, "adopt.take", seal(params, DEK));
      expect(open(first, DEK)).toEqual({ ok: false, error: "no such provider session" });

      const second = await callAndAwaitAck(socket, "adopt.take", seal(params, DEK));
      expect(adoptTake).toHaveBeenCalledTimes(2);
      expect(open(second, DEK)).toEqual({ sessionId: "sess_10" });
    });

    it("replies with a sealed error when params fail AdoptTakeParamsSchema", async () => {
      const socket = new FakeSocket();
      register(socket);

      const response = await callAndAwaitAck(
        socket,
        "adopt.take",
        seal({ providerSessionId: "p1", mode: "not-a-mode" }, DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });
  });

  describe("adopt.mirror", () => {
    function adoptMirrorParams(overrides: Record<string, unknown> = {}) {
      return {
        idempotencyKey: "idem_mirror_1",
        providerSessionId: "prov_1",
        ...overrides,
      };
    }

    it("decrypts params, calls adoptMirror, and seals the chunk result", async () => {
      const socket = new FakeSocket();
      const adoptMirror = vi.fn(
        async (): Promise<AdoptMirrorResult> => ({ chunk: "{}\n", nextCursor: null, done: true }),
      );
      register(socket, { adoptMirror });

      const params = adoptMirrorParams();
      const response = await callAndAwaitAck(socket, "adopt.mirror", seal(params, DEK));

      expect(adoptMirror).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ chunk: "{}\n", nextCursor: null, done: true });
    });

    it("replays the cached chunk for a retried idempotencyKey instead of re-reading", async () => {
      const socket = new FakeSocket();
      const adoptMirror = vi.fn(
        async (): Promise<AdoptMirrorResult> => ({ chunk: "a", nextCursor: 1, done: false }),
      );
      register(socket, { adoptMirror });

      const params = adoptMirrorParams();
      await callAndAwaitAck(socket, "adopt.mirror", seal(params, DEK));
      await callAndAwaitAck(socket, "adopt.mirror", seal(params, DEK));

      expect(adoptMirror).toHaveBeenCalledOnce();
    });

    it("does NOT replay a stale chunk when the same idempotencyKey is reused across different cursors — each cursor's params get their own cache entry", async () => {
      const socket = new FakeSocket();
      const adoptMirror = vi
        .fn()
        .mockResolvedValueOnce({ chunk: "chunk-0", nextCursor: 100, done: false })
        .mockResolvedValueOnce({ chunk: "chunk-100", nextCursor: null, done: true });
      register(socket, { adoptMirror });

      // Same idempotencyKey reused across a paginated sequence (misuse —
      // a real client should mint a fresh key per chunk — but must not
      // silently replay the first chunk for a differently-cursored call).
      const first = await callAndAwaitAck(
        socket,
        "adopt.mirror",
        seal(adoptMirrorParams({ cursor: 0 }), DEK),
      );
      const second = await callAndAwaitAck(
        socket,
        "adopt.mirror",
        seal(adoptMirrorParams({ cursor: 100 }), DEK),
      );

      expect(adoptMirror).toHaveBeenCalledTimes(2);
      expect(open(first, DEK)).toEqual({ chunk: "chunk-0", nextCursor: 100, done: false });
      expect(open(second, DEK)).toEqual({ chunk: "chunk-100", nextCursor: null, done: true });
    });

    it("replies with a sealed error when adoptMirror throws (e.g. unreadable transcript)", async () => {
      const socket = new FakeSocket();
      register(socket, {
        adoptMirror: vi.fn(async () => {
          throw new Error("ENOENT");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "adopt.mirror",
        seal(adoptMirrorParams(), DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "ENOENT" });
    });

    it("replies with a sealed error when params fail AdoptMirrorParamsSchema", async () => {
      const socket = new FakeSocket();
      register(socket);

      const response = await callAndAwaitAck(
        socket,
        "adopt.mirror",
        seal({ providerSessionId: "p1" }, DEK), // missing idempotencyKey
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });
  });

  describe("preview.ports", () => {
    it("decrypts params, calls previewPorts, and seals the result", async () => {
      const socket = new FakeSocket();
      const previewPorts = vi.fn(
        async (): Promise<PreviewPortsResult> => ({
          cloudflared: { installed: true, version: "2024.6.1" },
          ports: [{ port: 3000, address: "*", pid: 42, processName: "node" }],
        }),
      );
      register(socket, { previewPorts });

      const params = { idempotencyKey: "idem_ports_1" };
      const response = await callAndAwaitAck(socket, "preview.ports", seal(params, DEK));

      expect(previewPorts).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        cloudflared: { installed: true, version: "2024.6.1" },
        ports: [{ port: 3000, address: "*", pid: 42, processName: "node" }],
      });
    });

    it("replies with a sealed error when params fail PreviewPortsParamsSchema", async () => {
      const socket = new FakeSocket();
      register(socket);

      const response = await callAndAwaitAck(socket, "preview.ports", seal({}, DEK));
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });
  });

  describe("preview.tunnels", () => {
    it("decrypts params, calls previewTunnels, and seals the result", async () => {
      const socket = new FakeSocket();
      const previewTunnels = vi.fn(
        async (): Promise<PreviewTunnelsResult> => ({
          tunnels: [
            {
              tunnelId: "t1",
              port: 3000,
              url: "https://t1.trycloudflare.com",
              status: "active",
              startedAt: 1000,
            },
          ],
        }),
      );
      register(socket, { previewTunnels });

      const params = { idempotencyKey: "idem_tunnels_1" };
      const response = await callAndAwaitAck(socket, "preview.tunnels", seal(params, DEK));

      expect(previewTunnels).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        tunnels: [
          {
            tunnelId: "t1",
            port: 3000,
            url: "https://t1.trycloudflare.com",
            status: "active",
            startedAt: 1000,
          },
        ],
      });
    });
  });

  describe("preview.open", () => {
    function previewOpenParams(overrides: Record<string, unknown> = {}) {
      return { idempotencyKey: "idem_open_1", port: 3000, ...overrides };
    }

    it("decrypts params, calls previewOpen, and seals the result", async () => {
      const socket = new FakeSocket();
      const previewOpen = vi.fn(
        async (): Promise<PreviewOpenResult> => ({
          tunnelId: "t1",
          url: "https://t1.trycloudflare.com",
          port: 3000,
        }),
      );
      register(socket, { previewOpen });

      const params = previewOpenParams();
      const response = await callAndAwaitAck(socket, "preview.open", seal(params, DEK));

      expect(previewOpen).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        tunnelId: "t1",
        url: "https://t1.trycloudflare.com",
        port: 3000,
      });
    });

    it("replays the cached result for a retried idempotencyKey instead of spawning again", async () => {
      const socket = new FakeSocket();
      const previewOpen = vi.fn(
        async (): Promise<PreviewOpenResult> => ({
          tunnelId: "t1",
          url: "https://t1.trycloudflare.com",
          port: 3000,
        }),
      );
      register(socket, { previewOpen });

      const params = previewOpenParams();
      await callAndAwaitAck(socket, "preview.open", seal(params, DEK));
      await callAndAwaitAck(socket, "preview.open", seal(params, DEK));

      expect(previewOpen).toHaveBeenCalledOnce();
    });

    it("replies with a sealed error when previewOpen throws (e.g. cloudflared-not-installed)", async () => {
      const socket = new FakeSocket();
      register(socket, {
        previewOpen: vi.fn(async () => {
          throw new Error("cloudflared-not-installed");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "preview.open",
        seal(previewOpenParams(), DEK),
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "cloudflared-not-installed" });
    });

    it("replies with a sealed error when params fail PreviewOpenParamsSchema", async () => {
      const socket = new FakeSocket();
      register(socket);

      const response = await callAndAwaitAck(
        socket,
        "preview.open",
        seal({ idempotencyKey: "idem_1" }, DEK), // missing port
      );
      expect(open(response, DEK)).toEqual({ ok: false, error: "invalid-params" });
    });

    it("collapses two concurrent calls for the SAME port with DIFFERENT idempotencyKeys into one attempt (port guard)", async () => {
      const socket = new FakeSocket();
      let resolveOpen!: (value: PreviewOpenResult) => void;
      const deferred = new Promise<PreviewOpenResult>((resolve) => {
        resolveOpen = resolve;
      });
      const previewOpen = vi.fn(() => deferred);
      register(socket, { previewOpen });

      const fromDeviceA = previewOpenParams({ idempotencyKey: "idem_device_a", port: 4000 });
      const fromDeviceB = previewOpenParams({ idempotencyKey: "idem_device_b", port: 4000 });

      const responseA = callAndAwaitAck(socket, "preview.open", seal(fromDeviceA, DEK));
      const responseB = callAndAwaitAck(socket, "preview.open", seal(fromDeviceB, DEK));

      // Only one real spawn attempt is allowed for the same port — the
      // second device joins the first's in-flight attempt.
      expect(previewOpen).toHaveBeenCalledTimes(1);
      expect(previewOpen).toHaveBeenCalledWith(fromDeviceA);

      resolveOpen({ tunnelId: "t-shared", url: "https://t-shared.trycloudflare.com", port: 4000 });
      const [resultA, resultB] = await Promise.all([responseA, responseB]);

      const expected = {
        tunnelId: "t-shared",
        url: "https://t-shared.trycloudflare.com",
        port: 4000,
      };
      expect(open(resultA, DEK)).toEqual(expected);
      expect(open(resultB, DEK)).toEqual(expected);
      expect(previewOpen).toHaveBeenCalledTimes(1);
    });

    it("does NOT collapse concurrent calls for DIFFERENT ports — unrelated opens still run independently", async () => {
      const socket = new FakeSocket();
      const previewOpen = vi.fn(
        async (params: { port: number }): Promise<PreviewOpenResult> => ({
          tunnelId: `t-${params.port}`,
          url: `https://t-${params.port}.trycloudflare.com`,
          port: params.port,
        }),
      );
      register(socket, { previewOpen });

      const responseA = callAndAwaitAck(
        socket,
        "preview.open",
        seal(previewOpenParams({ idempotencyKey: "idem_a", port: 5000 }), DEK),
      );
      const responseB = callAndAwaitAck(
        socket,
        "preview.open",
        seal(previewOpenParams({ idempotencyKey: "idem_b", port: 5001 }), DEK),
      );

      const [resultA, resultB] = await Promise.all([responseA, responseB]);

      expect(previewOpen).toHaveBeenCalledTimes(2);
      expect(open(resultA, DEK)).toMatchObject({ port: 5000 });
      expect(open(resultB, DEK)).toMatchObject({ port: 5001 });
    });
  });

  describe("preview.close", () => {
    it("decrypts params, calls previewClose, and seals the result", async () => {
      const socket = new FakeSocket();
      const previewClose = vi.fn(async (): Promise<PreviewCloseResult> => ({ ok: true }));
      register(socket, { previewClose });

      const params = { idempotencyKey: "idem_close_1", tunnelId: "t1" };
      const response = await callAndAwaitAck(socket, "preview.close", seal(params, DEK));

      expect(previewClose).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ ok: true });
    });

    it("is not idempotency-cached — every call reaches the handler", async () => {
      const socket = new FakeSocket();
      const previewClose = vi.fn(async (): Promise<PreviewCloseResult> => ({ ok: true }));
      register(socket, { previewClose });

      const params = { idempotencyKey: "idem_close_1", tunnelId: "t1" };
      await callAndAwaitAck(socket, "preview.close", seal(params, DEK));
      await callAndAwaitAck(socket, "preview.close", seal(params, DEK));

      expect(previewClose).toHaveBeenCalledTimes(2);
    });
  });
  describe("workspace.getConfig (docs/features/setup-run-scripts.md)", () => {
    it("decrypts params, calls getWorkspaceConfig, and seals the result", async () => {
      const socket = new FakeSocket();
      const getWorkspaceConfig = vi.fn(async () => ({
        baseRef: "main",
        remote: "origin",
        setupScript: "npm install",
        runScript: "npm run dev",
      }));
      register(socket, { getWorkspaceConfig });

      const params = { idempotencyKey: "idem_ws_config_1", worktree: "/repo" };
      const response = await callAndAwaitAck(socket, "workspace.getConfig", seal(params, DEK));

      expect(getWorkspaceConfig).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        baseRef: "main",
        remote: "origin",
        setupScript: "npm install",
        runScript: "npm run dev",
      });
    });

    it("has no idempotency-key replay — a second call always calls getWorkspaceConfig again (read-only)", async () => {
      const socket = new FakeSocket();
      const getWorkspaceConfig = vi.fn(async () => ({}));
      register(socket, { getWorkspaceConfig });

      const params = { idempotencyKey: "idem_ws_config_2", worktree: "/repo" };
      await callAndAwaitAck(socket, "workspace.getConfig", seal(params, DEK));
      await callAndAwaitAck(socket, "workspace.getConfig", seal(params, DEK));

      expect(getWorkspaceConfig).toHaveBeenCalledTimes(2);
    });

    it("replies with a sealed error when getWorkspaceConfig throws (e.g. unregistered worktree)", async () => {
      const socket = new FakeSocket();
      register(socket, {
        getWorkspaceConfig: vi.fn(async () => {
          throw new Error("worktree is not inside a registered workspace: /repo");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "workspace.getConfig",
        seal({ idempotencyKey: "idem_ws_config_3", worktree: "/repo" }, DEK),
      );
      expect(open(response, DEK)).toEqual({
        ok: false,
        error: "worktree is not inside a registered workspace: /repo",
      });
    });
  });

  describe("run.start", () => {
    it("decrypts params, calls runStart, and seals the result", async () => {
      const socket = new FakeSocket();
      const runStart = vi.fn(async () => ({ started: true, method: "tmux" as const, pid: 555 }));
      register(socket, { runStart });

      const params = { idempotencyKey: "idem_run_start_1", worktree: "/repo" };
      const response = await callAndAwaitAck(socket, "run.start", seal(params, DEK));

      expect(runStart).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ started: true, method: "tmux", pid: 555 });
    });

    it("replies with a sealed error when runStart throws (e.g. no run script configured)", async () => {
      const socket = new FakeSocket();
      register(socket, {
        runStart: vi.fn(async () => {
          throw new Error("no run script configured for this workspace: /repo");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "run.start",
        seal({ idempotencyKey: "idem_run_start_2", worktree: "/repo" }, DEK),
      );
      expect(open(response, DEK)).toEqual({
        ok: false,
        error: "no run script configured for this workspace: /repo",
      });
    });

    it("replays the cached result for a retried idempotencyKey instead of starting again", async () => {
      const socket = new FakeSocket();
      const runStart = vi.fn(async () => ({ started: true, method: "detached" as const, pid: 1 }));
      register(socket, { runStart });

      const params = { idempotencyKey: "idem_run_start_3", worktree: "/repo" };
      const first = await callAndAwaitAck(socket, "run.start", seal(params, DEK));
      const second = await callAndAwaitAck(socket, "run.start", seal(params, DEK));

      expect(runStart).toHaveBeenCalledOnce();
      expect(open(first, DEK)).toEqual({ started: true, method: "detached", pid: 1 });
      expect(open(second, DEK)).toEqual({ started: true, method: "detached", pid: 1 });
    });

    it("collapses two concurrent calls with DIFFERENT idempotencyKeys for the SAME worktree into a single launch attempt", async () => {
      const socket = new FakeSocket();
      let resolveRunStart!: (value: { started: true }) => void;
      const runStart = vi.fn(
        () =>
          new Promise<{ started: true }>((resolve) => {
            resolveRunStart = resolve;
          }),
      );
      register(socket, { runStart });

      const fromDeviceA = { idempotencyKey: "idem_device_a", worktree: "/repo" };
      const fromDeviceB = { idempotencyKey: "idem_device_b", worktree: "/repo" };

      const responseA = callAndAwaitAck(socket, "run.start", seal(fromDeviceA, DEK));
      const responseB = callAndAwaitAck(socket, "run.start", seal(fromDeviceB, DEK));

      // Only one real launch attempt is allowed to happen — the second device
      // joins the first's in-flight attempt instead of racing its own
      // independent `run.start`.
      expect(runStart).toHaveBeenCalledTimes(1);
      expect(runStart).toHaveBeenCalledWith(fromDeviceA);

      resolveRunStart({ started: true });
      const [resultA, resultB] = await Promise.all([responseA, responseB]);

      expect(open(resultA, DEK)).toEqual({ started: true });
      expect(open(resultB, DEK)).toEqual({ started: true });
      expect(runStart).toHaveBeenCalledTimes(1);
    });

    it("does NOT collapse concurrent calls for DIFFERENT worktrees — unrelated run.start calls still run independently", async () => {
      const socket = new FakeSocket();
      const runStart = vi.fn(async (params: { worktree: string }) => ({
        started: true,
        pid: params.worktree === "/repo-a" ? 1 : 2,
      }));
      register(socket, { runStart });

      const responseA = callAndAwaitAck(
        socket,
        "run.start",
        seal({ idempotencyKey: "idem_a", worktree: "/repo-a" }, DEK),
      );
      const responseB = callAndAwaitAck(
        socket,
        "run.start",
        seal({ idempotencyKey: "idem_b", worktree: "/repo-b" }, DEK),
      );

      const [resultA, resultB] = await Promise.all([responseA, responseB]);

      expect(runStart).toHaveBeenCalledTimes(2);
      expect(open(resultA, DEK)).toEqual({ started: true, pid: 1 });
      expect(open(resultB, DEK)).toEqual({ started: true, pid: 2 });
    });
  });

  describe("run.stop", () => {
    it("decrypts params, calls runStop, and seals the result", async () => {
      const socket = new FakeSocket();
      const runStop = vi.fn(async () => ({ stopped: true, wasRunning: true }));
      register(socket, { runStop });

      const params = { idempotencyKey: "idem_run_stop_1", worktree: "/repo" };
      const response = await callAndAwaitAck(socket, "run.stop", seal(params, DEK));

      expect(runStop).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ stopped: true, wasRunning: true });
    });

    it("replays the cached result for a retried idempotencyKey instead of stopping again", async () => {
      const socket = new FakeSocket();
      const runStop = vi.fn(async () => ({ stopped: true, wasRunning: true }));
      register(socket, { runStop });

      const params = { idempotencyKey: "idem_run_stop_2", worktree: "/repo" };
      await callAndAwaitAck(socket, "run.stop", seal(params, DEK));
      await callAndAwaitAck(socket, "run.stop", seal(params, DEK));

      expect(runStop).toHaveBeenCalledOnce();
    });

    it("replies with a sealed error when runStop throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        runStop: vi.fn(async () => {
          throw new Error("worktree is not inside a registered workspace: /repo");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "run.stop",
        seal({ idempotencyKey: "idem_run_stop_3", worktree: "/repo" }, DEK),
      );
      expect(open(response, DEK)).toEqual({
        ok: false,
        error: "worktree is not inside a registered workspace: /repo",
      });
    });
  });

  describe("run.status", () => {
    it("decrypts params, calls runStatus, and seals the result", async () => {
      const socket = new FakeSocket();
      const runStatus = vi.fn(async () => ({
        run: { state: "running" as const, pid: 1, method: "tmux" as const, startedAt: 1 },
        setup: { state: "succeeded" as const, exitCode: 0, startedAt: 1, finishedAt: 2 },
      }));
      register(socket, { runStatus });

      const params = { idempotencyKey: "idem_run_status_1", worktree: "/repo" };
      const response = await callAndAwaitAck(socket, "run.status", seal(params, DEK));

      expect(runStatus).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({
        run: { state: "running", pid: 1, method: "tmux", startedAt: 1 },
        setup: { state: "succeeded", exitCode: 0, startedAt: 1, finishedAt: 2 },
      });
    });

    it("has no idempotency-key replay — a second call always calls runStatus again (read-only)", async () => {
      const socket = new FakeSocket();
      const runStatus = vi.fn(async () => ({
        run: { state: "none" as const },
        setup: { state: "not-run" as const },
      }));
      register(socket, { runStatus });

      const params = { idempotencyKey: "idem_run_status_2", worktree: "/repo" };
      await callAndAwaitAck(socket, "run.status", seal(params, DEK));
      await callAndAwaitAck(socket, "run.status", seal(params, DEK));

      expect(runStatus).toHaveBeenCalledTimes(2);
    });

    it("replies with a sealed error when runStatus throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        runStatus: vi.fn(async () => {
          throw new Error("worktree is not inside a registered workspace: /repo");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "run.status",
        seal({ idempotencyKey: "idem_run_status_3", worktree: "/repo" }, DEK),
      );
      expect(open(response, DEK)).toEqual({
        ok: false,
        error: "worktree is not inside a registered workspace: /repo",
      });
    });
  });

  describe("run.setup", () => {
    it("decrypts params, calls runSetup, and seals the result", async () => {
      const socket = new FakeSocket();
      const runSetup = vi.fn(async () => ({ started: true }));
      register(socket, { runSetup });

      const params = { idempotencyKey: "idem_run_setup_1", worktree: "/repo" };
      const response = await callAndAwaitAck(socket, "run.setup", seal(params, DEK));

      expect(runSetup).toHaveBeenCalledExactlyOnceWith(params);
      expect(open(response, DEK)).toEqual({ started: true });
    });

    it("replays the cached result for a retried idempotencyKey instead of re-running setup", async () => {
      const socket = new FakeSocket();
      const runSetup = vi.fn(async () => ({ started: true }));
      register(socket, { runSetup });

      const params = { idempotencyKey: "idem_run_setup_2", worktree: "/repo" };
      await callAndAwaitAck(socket, "run.setup", seal(params, DEK));
      await callAndAwaitAck(socket, "run.setup", seal(params, DEK));

      expect(runSetup).toHaveBeenCalledOnce();
    });

    it("replies with a sealed error when runSetup throws", async () => {
      const socket = new FakeSocket();
      register(socket, {
        runSetup: vi.fn(async () => {
          throw new Error("worktree is not inside a registered workspace: /repo");
        }),
      });

      const response = await callAndAwaitAck(
        socket,
        "run.setup",
        seal({ idempotencyKey: "idem_run_setup_3", worktree: "/repo" }, DEK),
      );
      expect(open(response, DEK)).toEqual({
        ok: false,
        error: "worktree is not inside a registered workspace: /repo",
      });
    });
  });

  it("replies with a sealed error for an unknown method", async () => {
    const socket = new FakeSocket();
    register(socket);

    const response = await callAndAwaitAck(socket, "nonsense", seal({}, DEK));
    expect(open(response, DEK)).toEqual({ ok: false, error: "unknown-method" });
  });

  it("replies with a sealed error when params is not a well-formed EncryptedBox", async () => {
    const socket = new FakeSocket();
    register(socket);

    const response = await callAndAwaitAck(socket, "spawn", { not: "a box" });
    expect(open(response, DEK)).toEqual({ ok: false, error: "malformed-params" });
  });

  it("replies with a sealed error when params fail to decrypt under this machine's dek", async () => {
    const socket = new FakeSocket();
    register(socket);

    const wrongDek = new Uint8Array(32).fill(9);
    const response = await callAndAwaitAck(socket, "spawn", seal(spawnParams(), wrongDek));
    expect(open(response, DEK)).toEqual({ ok: false, error: "decrypt-failed" });
  });

  it("stop() removes this module's listeners from the socket", () => {
    const socket = new FakeSocket();
    const handle = register(socket);

    expect(socket.handlers.get("rpc-request")?.length).toBe(1);
    handle.stop();
    expect(socket.handlers.get("rpc-request")?.length).toBe(0);
    expect(socket.handlers.get("connect")?.length).toBe(0);
  });
});
