import { describe, expect, it, vi } from "vitest";
import { runSpawnFlow, SpawnFlowError } from "../spawn-flow";
import type { NewSessionActions, SpawnRequest } from "../types";

const request: SpawnRequest = {
  directory: "/repo",
  provider: "claude-code",
  permissionMode: "default",
};

describe("runSpawnFlow", () => {
  it("spawns directly when the directory already exists", async () => {
    const spawn = vi.fn(async () => ({ type: "success" as const, sessionId: "sess-1" }));
    const createDirectory = vi.fn();
    const registerWorkspace = vi.fn();
    const confirm = vi.fn();

    const result = await runSpawnFlow(
      { spawn, createDirectory, registerWorkspace } as unknown as NewSessionActions,
      request,
      confirm,
    );

    expect(result).toEqual({ outcome: "spawned", sessionId: "sess-1" });
    expect(createDirectory).not.toHaveBeenCalled();
    expect(registerWorkspace).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("creates the directory and retries spawn when approved", async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({
        type: "requiresApproval",
        action: "create-directory",
        directory: "/repo",
      })
      .mockResolvedValueOnce({ type: "success", sessionId: "sess-2" });
    const createDirectory = vi.fn(async () => {});
    const registerWorkspace = vi.fn();
    const confirm = vi.fn(async () => true);

    const result = await runSpawnFlow(
      { spawn, createDirectory, registerWorkspace } as unknown as NewSessionActions,
      request,
      confirm,
    );

    expect(confirm).toHaveBeenCalledExactlyOnceWith("/repo", "create-directory");
    expect(createDirectory).toHaveBeenCalledExactlyOnceWith("/repo");
    expect(registerWorkspace).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ outcome: "spawned", sessionId: "sess-2" });
  });

  it("returns declined and never creates the directory when the user says no", async () => {
    const spawn = vi.fn(async () => ({
      type: "requiresApproval" as const,
      action: "create-directory" as const,
      directory: "/repo",
    }));
    const createDirectory = vi.fn();
    const registerWorkspace = vi.fn();
    const confirm = vi.fn(async () => false);

    const result = await runSpawnFlow(
      { spawn, createDirectory, registerWorkspace } as unknown as NewSessionActions,
      request,
      confirm,
    );

    expect(result).toEqual({ outcome: "declined" });
    expect(createDirectory).not.toHaveBeenCalled();
    expect(registerWorkspace).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("throws SpawnFlowError if the directory is still reported missing after creation", async () => {
    const spawn = vi.fn(async () => ({
      type: "requiresApproval" as const,
      action: "create-directory" as const,
      directory: "/repo",
    }));
    const createDirectory = vi.fn(async () => {});
    const registerWorkspace = vi.fn();
    const confirm = vi.fn(async () => true);

    await expect(
      runSpawnFlow(
        { spawn, createDirectory, registerWorkspace } as unknown as NewSessionActions,
        request,
        confirm,
      ),
    ).rejects.toThrow(SpawnFlowError);
  });

  // Flow 3 — spawn-fresh-folder-register (Piece A): a genuinely fresh
  // folder picked cold in the web UI, never `falcon workspace register`'d
  // from a terminal, resolves the *same* approval-loop shape as
  // create-directory, just with `action: "register-workspace"` and
  // `registerWorkspace` in place of `createDirectory`.
  describe("register-workspace branch", () => {
    it("approve -> register -> retry -> success", async () => {
      const spawn = vi
        .fn()
        .mockResolvedValueOnce({
          type: "requiresApproval",
          action: "register-workspace",
          directory: "/fresh/repo",
        })
        .mockResolvedValueOnce({ type: "success", sessionId: "sess-registered-1" });
      const createDirectory = vi.fn();
      const registerWorkspace = vi.fn(async () => {});
      const confirm = vi.fn(async () => true);

      const result = await runSpawnFlow(
        { spawn, createDirectory, registerWorkspace } as unknown as NewSessionActions,
        request,
        confirm,
      );

      expect(confirm).toHaveBeenCalledExactlyOnceWith("/fresh/repo", "register-workspace");
      expect(registerWorkspace).toHaveBeenCalledExactlyOnceWith("/fresh/repo");
      expect(createDirectory).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ outcome: "spawned", sessionId: "sess-registered-1" });
    });

    it("decline -> declined, and never registers the workspace", async () => {
      const spawn = vi.fn(async () => ({
        type: "requiresApproval" as const,
        action: "register-workspace" as const,
        directory: "/fresh/repo",
      }));
      const createDirectory = vi.fn();
      const registerWorkspace = vi.fn();
      const confirm = vi.fn(async () => false);

      const result = await runSpawnFlow(
        { spawn, createDirectory, registerWorkspace } as unknown as NewSessionActions,
        request,
        confirm,
      );

      expect(result).toEqual({ outcome: "declined" });
      expect(registerWorkspace).not.toHaveBeenCalled();
      expect(createDirectory).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("throws SpawnFlowError if the workspace is still reported unregistered after registering it", async () => {
      const spawn = vi.fn(async () => ({
        type: "requiresApproval" as const,
        action: "register-workspace" as const,
        directory: "/fresh/repo",
      }));
      const createDirectory = vi.fn();
      const registerWorkspace = vi.fn(async () => {});
      const confirm = vi.fn(async () => true);

      await expect(
        runSpawnFlow(
          { spawn, createDirectory, registerWorkspace } as unknown as NewSessionActions,
          request,
          confirm,
        ),
      ).rejects.toThrow(SpawnFlowError);
    });
  });
});
