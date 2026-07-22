import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { open, seal } from "@falcon/crypto";
import type {
  AdoptMirrorResult,
  AdoptTakeResult,
  EncryptedBox,
  FsListResult,
  FsMkdirResult,
  SpawnParams,
  SpawnResult,
  WorkspaceRegisterResult,
} from "@falcon/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MACHINE_RPC_METHODS,
  type MachineRpcDeps,
  registerMachineRpcHandlers,
} from "./machineRpc.js";

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
  "spawnSession" | "resumeSession" | "adoptTake" | "adoptMirror"
> {
  return {
    spawnSession: vi.fn(),
    resumeSession: vi.fn(),
    adoptTake: vi.fn(),
    adoptMirror: vi.fn(),
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
      payload: { target: "m:mach_1:github.checks" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:commands.list" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:adopt.take" },
    });
    expect(socket.emitted).toContainEqual({
      event: "rpc-register",
      payload: { target: "m:mach_1:adopt.mirror" },
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
