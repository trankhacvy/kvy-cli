import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SpawnParams } from "@falcon/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchedProcess } from "./processLauncher.js";
import {
  type SpawnEngineDeps,
  SpawnError,
  scanForLiveSessionInDirectory,
  spawnSession,
} from "./spawnEngine.js";
import type { TrackedSession } from "./types.js";

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

  describe("setup-script hook (docs/features/setup-run-scripts.md Phase 2)", () => {
    it("fires runSetupScript exactly once, with the workspace root and the created worktree dir, on a genuine fresh-worktree creation", async () => {
      const git = vi.fn(async (args: string[]) => {
        if (args[0] === "show-ref") throw new Error("not found");
        return "";
      });
      const runSetupScript = vi.fn();
      const deps = baseDeps({ gitWorktreeDeps: { git }, runSetupScript });

      await spawnSession(
        baseParams({ directory: root, branch: { name: "task-1", createWorktree: true } }),
        deps,
      );

      const realRoot = await realpath(root);
      expect(runSetupScript).toHaveBeenCalledExactlyOnceWith(
        realRoot,
        path.join(realRoot, ".worktrees", "task-1"),
      );
    });

    it("does NOT fire runSetupScript when the worktree already existed (idempotent reuse)", async () => {
      const worktreeDir = path.join(await realpath(root), ".worktrees", "task-1");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(worktreeDir, { recursive: true });
      const git = vi.fn(async () => "");
      const runSetupScript = vi.fn();
      const deps = baseDeps({ gitWorktreeDeps: { git }, runSetupScript });

      await spawnSession(
        baseParams({ directory: root, branch: { name: "task-1", createWorktree: true } }),
        deps,
      );

      expect(runSetupScript).not.toHaveBeenCalled();
    });

    it("does NOT fire runSetupScript for an in-place checkout (createWorktree: false)", async () => {
      const git = vi.fn(async () => "");
      const runSetupScript = vi.fn();
      const deps = baseDeps({ gitWorktreeDeps: { git }, runSetupScript });

      await spawnSession(
        baseParams({ directory: root, branch: { name: "main", createWorktree: false } }),
        deps,
      );

      expect(runSetupScript).not.toHaveBeenCalled();
    });

    it("does NOT fire runSetupScript for a plain, branch-less spawn", async () => {
      const runSetupScript = vi.fn();
      const deps = baseDeps({ runSetupScript });

      await spawnSession(baseParams({ directory: root }), deps);

      expect(runSetupScript).not.toHaveBeenCalled();
    });

    it("does not await runSetupScript — spawn resolves even if it never settles", async () => {
      const git = vi.fn(async (args: string[]) => {
        if (args[0] === "show-ref") throw new Error("not found");
        return "";
      });
      // A `runSetupScript` that kicks off a promise that never resolves
      // (fire-and-forget, its return value ignored — the real dep's type is
      // `void`) would hang `spawnSession` forever if it were (incorrectly)
      // awaited.
      const runSetupScript = vi.fn(() => {
        void new Promise<void>(() => {});
      });
      const deps = baseDeps({ gitWorktreeDeps: { git }, runSetupScript });

      const result = await spawnSession(
        baseParams({ directory: root, branch: { name: "task-1", createWorktree: true } }),
        deps,
      );

      expect(result).toEqual({ sessionId: "sess_new" });
    });

    it("spawns normally when no runSetupScript dep is configured at all", async () => {
      const git = vi.fn(async (args: string[]) => {
        if (args[0] === "show-ref") throw new Error("not found");
        return "";
      });
      const deps = baseDeps({ gitWorktreeDeps: { git } });
      expect(deps.runSetupScript).toBeUndefined();

      const result = await spawnSession(
        baseParams({ directory: root, branch: { name: "task-1", createWorktree: true } }),
        deps,
      );

      expect(result).toEqual({ sessionId: "sess_new" });
    });
  });

  describe("directory dedup (plan.md §16 'Flow 3 — spawn-directory-dedup')", () => {
    it("returns the already-live session's id and never invokes the process launcher when one is already tracked in this exact directory", async () => {
      const realRoot = await realpath(root);
      const deps = baseDeps({
        findLiveSessionInDirectory: (realDirectory) =>
          realDirectory === realRoot ? "sess_already_live" : null,
      });

      const result = await spawnSession(baseParams({ directory: root }), deps);

      expect(result).toEqual({ sessionId: "sess_already_live" });
      // The load-bearing assertion: a false pass here (e.g. asserting only
      // that *a* sessionId came back) would hide a real double spawn — the
      // launcher must never even be called.
      expect(deps.launchProcess).not.toHaveBeenCalled();
      expect(deps.awaiter.waitFor).not.toHaveBeenCalled();
    });

    it("proceeds with a normal spawn when findLiveSessionInDirectory reports nothing live there", async () => {
      const deps = baseDeps({ findLiveSessionInDirectory: () => null });

      const result = await spawnSession(baseParams({ directory: root }), deps);

      expect(result).toEqual({ sessionId: "sess_new" });
      expect(deps.launchProcess).toHaveBeenCalledOnce();
    });

    it("spawns normally when no findLiveSessionInDirectory dep is configured at all", async () => {
      const deps = baseDeps();
      expect(deps.findLiveSessionInDirectory).toBeUndefined();

      const result = await spawnSession(baseParams({ directory: root }), deps);

      expect(result).toEqual({ sessionId: "sess_new" });
      expect(deps.launchProcess).toHaveBeenCalledOnce();
    });

    it("records the launched pid's directory via trackSpawned right after a successful launch", async () => {
      const trackSpawned = vi.fn();
      const deps = baseDeps({ trackSpawned });

      await spawnSession(baseParams({ directory: root }), deps);

      const realRoot = await realpath(root);
      expect(trackSpawned).toHaveBeenCalledExactlyOnceWith(4242, realRoot);
    });

    it("keys dedup on the FINAL post-worktree directory: a live session at repo root does not dedupe a worktree-mode spawn for the same repo (docs/features/worktree-isolation.md Phase 3)", async () => {
      const git = vi.fn(async (args: string[]) => {
        if (args[0] === "show-ref") throw new Error("not found");
        return "";
      });
      const realRoot = await realpath(root);
      const deps = baseDeps({
        gitWorktreeDeps: { git },
        findLiveSessionInDirectory: (directory) =>
          directory === realRoot ? "sess_repo_root_live" : null,
      });

      const result = await spawnSession(
        baseParams({ directory: root, branch: { name: "task-1", createWorktree: true } }),
        deps,
      );

      // A live session at the (pre-worktree) repo root must NOT be returned
      // for a worktree-mode spawn — the worktree directory is different, so
      // this proceeds to a real launch there instead.
      expect(result).toEqual({ sessionId: "sess_new" });
      expect(deps.launchProcess).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ cwd: path.join(realRoot, ".worktrees", "task-1") }),
        undefined,
      );
    });

    it("dedupes a second worktree-mode spawn for the same branch against the session already tracked in that worktree directory", async () => {
      const git = vi.fn(async () => "");
      const realRoot = await realpath(root);
      const worktreeDir = path.join(realRoot, ".worktrees", "task-1");
      const deps = baseDeps({
        gitWorktreeDeps: { git },
        findLiveSessionInDirectory: (directory) =>
          directory === worktreeDir ? "sess_worktree_live" : null,
      });

      const result = await spawnSession(
        baseParams({ directory: root, branch: { name: "task-1", createWorktree: true } }),
        deps,
      );

      expect(result).toEqual({ sessionId: "sess_worktree_live" });
      expect(deps.launchProcess).not.toHaveBeenCalled();
    });

    it("does not regress FL3.1: a fresh, never-registered workspaceId still resolves to the register-workspace approval, not the dedup path", async () => {
      // `findLiveSessionInDirectory` is wired (as the real daemon composition
      // always wires it) and would (wrongly, if ever reached) claim a live
      // session exists here — but workspace validation fails FIRST for an
      // unregistered workspaceId, so the dedup scan must never even run.
      const findLiveSessionInDirectory = vi.fn(() => "sess_should_never_be_returned");
      const deps = baseDeps({
        resolveWorkspaceRoot: () => null,
        findLiveSessionInDirectory,
      });

      const result = await spawnSession(baseParams({ directory: root }), deps);

      expect(result).toEqual({
        requiresApproval: { action: "register-workspace", directory: root },
      });
      expect(findLiveSessionInDirectory).not.toHaveBeenCalled();
      expect(deps.launchProcess).not.toHaveBeenCalled();
    });
  });
});

describe("scanForLiveSessionInDirectory", () => {
  function session(overrides: Partial<TrackedSession> = {}): TrackedSession {
    return { startedBy: "daemon", pid: 1, ...overrides };
  }

  it("returns the sessionId of a live tracked session whose directory matches", () => {
    const sessions = [
      session({ pid: 1, sessionId: "sess_a", directory: "/repos/a" }),
      session({ pid: 2, sessionId: "sess_b", directory: "/repos/b" }),
    ];
    expect(scanForLiveSessionInDirectory(sessions, "/repos/b")).toBe("sess_b");
  });

  it("returns null when no tracked session matches the directory", () => {
    const sessions = [session({ pid: 1, sessionId: "sess_a", directory: "/repos/a" })];
    expect(scanForLiveSessionInDirectory(sessions, "/repos/never-seen")).toBeNull();
  });

  it("ignores a pid tracked pre-webhook (no sessionId yet) even if its directory matches", () => {
    const sessions = [session({ pid: 1, directory: "/repos/a" })];
    expect(scanForLiveSessionInDirectory(sessions, "/repos/a")).toBeNull();
  });
});
