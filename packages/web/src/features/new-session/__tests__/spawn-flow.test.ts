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
    const confirm = vi.fn();

    const result = await runSpawnFlow(
      { spawn, createDirectory } as unknown as NewSessionActions,
      request,
      confirm,
    );

    expect(result).toEqual({ outcome: "spawned", sessionId: "sess-1" });
    expect(createDirectory).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("creates the directory and retries spawn when approved", async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ type: "requiresApproval", directory: "/repo" })
      .mockResolvedValueOnce({ type: "success", sessionId: "sess-2" });
    const createDirectory = vi.fn(async () => {});
    const confirm = vi.fn(async () => true);

    const result = await runSpawnFlow(
      { spawn, createDirectory } as unknown as NewSessionActions,
      request,
      confirm,
    );

    expect(confirm).toHaveBeenCalledExactlyOnceWith("/repo");
    expect(createDirectory).toHaveBeenCalledExactlyOnceWith("/repo");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ outcome: "spawned", sessionId: "sess-2" });
  });

  it("returns declined and never creates the directory when the user says no", async () => {
    const spawn = vi.fn(async () => ({ type: "requiresApproval" as const, directory: "/repo" }));
    const createDirectory = vi.fn();
    const confirm = vi.fn(async () => false);

    const result = await runSpawnFlow(
      { spawn, createDirectory } as unknown as NewSessionActions,
      request,
      confirm,
    );

    expect(result).toEqual({ outcome: "declined" });
    expect(createDirectory).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("throws SpawnFlowError if the directory is still reported missing after creation", async () => {
    const spawn = vi.fn(async () => ({ type: "requiresApproval" as const, directory: "/repo" }));
    const createDirectory = vi.fn(async () => {});
    const confirm = vi.fn(async () => true);

    await expect(
      runSpawnFlow({ spawn, createDirectory } as unknown as NewSessionActions, request, confirm),
    ).rejects.toThrow(SpawnFlowError);
  });
});
