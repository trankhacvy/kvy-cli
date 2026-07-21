import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SpawnParams } from "@falcon/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchedProcess } from "./processLauncher.js";
import { type SpawnEngineDeps, SpawnError, spawnSession } from "./spawnEngine.js";

function baseParams(overrides: Partial<SpawnParams> = {}): SpawnParams {
  return {
    idempotencyKey: "idem_1",
    workspaceId: "ws_1",
    directory: "/will-be-overridden",
    provider: "claude-code",
    permissionMode: "default",
    ...overrides,
  };
}

describe("spawnSession", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "falcon-spawn-engine-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function baseDeps(overrides: Partial<SpawnEngineDeps> = {}): SpawnEngineDeps {
    const launched: LaunchedProcess = { method: "detached", pid: 4242 };
    return {
      resolveWorkspaceRoot: () => root,
      awaiter: {
        waitFor: vi.fn(async (pid: number) => ({ sessionId: "sess_new", pid })),
        resolve: vi.fn(() => true),
      },
      launchProcess: vi.fn(async () => launched),
      falconEntrypoint: () => ["/usr/bin/node", "/opt/falcon/dist/index.mjs"],
      baseEnv: {},
      ...overrides,
    };
  }

  it("validates the workspace, launches the provider process, and resolves via the awaiter by pid", async () => {
    const deps = baseDeps();
    const result = await spawnSession(baseParams({ directory: root }), deps);

    expect(result).toEqual({ sessionId: "sess_new" });
    expect(deps.launchProcess).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionLabel: "idem_1",
        command: "/usr/bin/node",
        args: [
          "/opt/falcon/dist/index.mjs",
          "claude",
          "--starting-mode",
          "remote",
          "--started-by",
          "daemon",
          "--permission-mode",
          "default",
        ],
      }),
      undefined,
    );
    expect(deps.awaiter.waitFor).toHaveBeenCalledExactlyOnceWith(4242);
  });

  it("maps provider claude-code -> claude and codex -> codex in the built argv", async () => {
    const deps = baseDeps();
    await spawnSession(baseParams({ directory: root, provider: "codex" }), deps);
    expect(deps.launchProcess).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ args: expect.arrayContaining(["codex"]) }),
      undefined,
    );
  });

  it("passes --model and --continue-from through when present", async () => {
    const deps = baseDeps();
    await spawnSession(
      baseParams({
        directory: root,
        model: "opus",
        continueFrom: { providerSessionId: "prov_123" },
      }),
      deps,
    );
    expect(deps.launchProcess).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        args: expect.arrayContaining(["--model", "opus", "--continue-from", "prov_123"]),
      }),
      undefined,
    );
  });

  it("rejects a directory outside the registered workspace root", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "falcon-outside-"));
    try {
      const deps = baseDeps();
      await expect(spawnSession(baseParams({ directory: outside }), deps)).rejects.toThrow(
        SpawnError,
      );
      expect(deps.launchProcess).not.toHaveBeenCalled();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("fails fast when the env template references an unresolved variable", async () => {
    const deps = baseDeps({ envTemplate: { URL: "${MISSING_VAR}" }, baseEnv: {} });
    await expect(spawnSession(baseParams({ directory: root }), deps)).rejects.toThrow(
      /unresolved variable/,
    );
    expect(deps.launchProcess).not.toHaveBeenCalled();
  });

  it("merges expanded env vars into the spawned process's environment", async () => {
    const deps = baseDeps({
      envTemplate: { FALCON_BACKEND_URL: "${BACKEND_URL}" },
      baseEnv: { BACKEND_URL: "https://api.example.com" },
    });
    await spawnSession(baseParams({ directory: root }), deps);
    expect(deps.launchProcess).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        env: expect.objectContaining({ FALCON_BACKEND_URL: "https://api.example.com" }),
      }),
      undefined,
    );
  });

  it("wraps a launch failure in SpawnError", async () => {
    const deps = baseDeps({
      launchProcess: vi.fn(async () => {
        throw new Error("spawn falcon ENOENT");
      }),
    });
    await expect(spawnSession(baseParams({ directory: root }), deps)).rejects.toThrow(
      /failed to launch provider process/,
    );
  });

  it("wraps an awaiter timeout in SpawnError, including the pid and launch method", async () => {
    const deps = baseDeps({
      awaiter: {
        waitFor: vi.fn(async () => {
          throw new Error("timed out");
        }),
        resolve: vi.fn(() => false),
      },
    });
    await expect(spawnSession(baseParams({ directory: root }), deps)).rejects.toThrow(
      /spawn launched \(pid 4242, detached\) but timed out/,
    );
  });

  it("returns a requiresApproval result (not a throw) when the directory doesn't exist yet", async () => {
    const missing = path.join(root, "brand-new-project");
    const deps = baseDeps();

    const result = await spawnSession(baseParams({ directory: missing }), deps);

    expect(result).toEqual({
      requiresApproval: { action: "create-directory", directory: missing },
    });
    expect(deps.launchProcess).not.toHaveBeenCalled();
  });

  it("returns a register-workspace requiresApproval result (not a throw) when workspaceId is unregistered", async () => {
    const deps = baseDeps({ resolveWorkspaceRoot: () => null });

    const result = await spawnSession(baseParams({ directory: root }), deps);

    expect(result).toEqual({
      requiresApproval: { action: "register-workspace", directory: root },
    });
    expect(deps.launchProcess).not.toHaveBeenCalled();
  });

  it("launches on retry after the workspace is registered (simulated register-then-retry, same idempotencyKey)", async () => {
    let registered = false;
    const deps = baseDeps({ resolveWorkspaceRoot: () => (registered ? root : null) });
    const params = baseParams({ directory: root });

    const first = await spawnSession(params, deps);
    expect(first).toEqual({
      requiresApproval: { action: "register-workspace", directory: root },
    });
    expect(deps.launchProcess).not.toHaveBeenCalled();

    // Simulates the web flow calling the new `workspace.register` RPC
    // between the two `spawn` attempts, then retrying with the same
    // `idempotencyKey` (`spawn-flow.ts`'s register-workspace branch).
    registered = true;
    const second = await spawnSession(params, deps);
    expect(second).toEqual({ sessionId: "sess_new" });
    expect(deps.launchProcess).toHaveBeenCalledOnce();
  });

  it("still throws for a directory that exists but is outside the workspace root (not a requiresApproval case)", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "falcon-outside-2-"));
    try {
      const deps = baseDeps();
      await expect(spawnSession(baseParams({ directory: outside }), deps)).rejects.toThrow(
        SpawnError,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("resolves params.branch via gitWorktree and launches in the returned directory", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "show-ref") throw new Error("not found");
      return "";
    });
    const deps = baseDeps({ gitWorktreeDeps: { git } });

    await spawnSession(
      baseParams({ directory: root, branch: { name: "task-1", createWorktree: true } }),
      deps,
    );

    // realpath'd for comparison — on macOS `mkdtemp` under `/tmp` resolves
    // through a `/private` symlink, and the engine launches in the
    // *resolved* workspace directory's `.worktrees/<branch>`.
    const expectedDir = path.join(await realpath(root), ".worktrees", "task-1");
    expect(deps.launchProcess).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cwd: expectedDir }),
      undefined,
    );
  });

  it("wraps a gitWorktree failure in SpawnError and never launches", async () => {
    const git = vi.fn(async () => {
      throw new Error("fatal: not a git repository");
    });
    const deps = baseDeps({ gitWorktreeDeps: { git } });

    await expect(
      spawnSession(
        baseParams({ directory: root, branch: { name: "task-1", createWorktree: false } }),
        deps,
      ),
    ).rejects.toThrow(/branch\/worktree setup failed/);
    expect(deps.launchProcess).not.toHaveBeenCalled();
  });
});
