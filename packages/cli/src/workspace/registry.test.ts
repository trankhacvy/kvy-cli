import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isWithinRegisteredWorkspace,
  listWorkspaces,
  registerWorkspace,
  resolveWorkspacePath,
  unregisterWorkspace,
} from "./registry.js";

let homeDir: string;
let workspaceDir: string;

beforeEach(async () => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-workspace-registry-home-"));
  workspaceDir = await realpath(
    mkdtempSync(path.join(tmpdir(), "falcon-workspace-registry-repo-")),
  );
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("registerWorkspace", () => {
  it("creates a new entry with a registeredAt timestamp", async () => {
    const before = Date.now();
    const entry = await registerWorkspace(workspaceDir, {}, { homeDir });
    const after = Date.now();

    expect(entry.path).toBe(workspaceDir);
    expect(entry.displayName).toBeUndefined();
    const registeredAt = new Date(entry.registeredAt).getTime();
    expect(registeredAt).toBeGreaterThanOrEqual(before);
    expect(registeredAt).toBeLessThanOrEqual(after);
  });

  it("stores an optional displayName", async () => {
    const entry = await registerWorkspace(workspaceDir, { displayName: "My Repo" }, { homeDir });
    expect(entry.displayName).toBe("My Repo");
  });

  it("is idempotent: re-registering the same directory doesn't duplicate or change registeredAt", async () => {
    const first = await registerWorkspace(workspaceDir, {}, { homeDir });
    const second = await registerWorkspace(workspaceDir, {}, { homeDir });

    expect(second.registeredAt).toBe(first.registeredAt);
    const all = await listWorkspaces({ homeDir });
    expect(all).toHaveLength(1);
  });

  it("re-registering with a new displayName updates it without touching registeredAt", async () => {
    const first = await registerWorkspace(workspaceDir, { displayName: "old" }, { homeDir });
    const second = await registerWorkspace(workspaceDir, { displayName: "new" }, { homeDir });

    expect(second.displayName).toBe("new");
    expect(second.registeredAt).toBe(first.registeredAt);
  });

  it("resolves a symlinked directory to its real path before storing", async () => {
    const link = path.join(tmpdir(), `falcon-workspace-registry-link-${Date.now()}`);
    const { symlink, unlink } = await import("node:fs/promises");
    await symlink(workspaceDir, link);
    try {
      const entry = await registerWorkspace(link, {}, { homeDir });
      expect(entry.path).toBe(workspaceDir);
    } finally {
      await unlink(link).catch(() => {});
    }
  });

  it("pre-registers a directory that doesn't exist yet, falling back to its resolved absolute path", async () => {
    const missing = path.join(workspaceDir, "not-created-yet");
    const entry = await registerWorkspace(missing, {}, { homeDir });
    expect(entry.path).toBe(path.resolve(missing));
  });

  it("leaves no .lock or .tmp file behind after a successful register", async () => {
    await registerWorkspace(workspaceDir, {}, { homeDir });
    expect(() => statSync(path.join(homeDir, "workspaces.json.lock"))).toThrow();
    expect(() => statSync(path.join(homeDir, "workspaces.json.tmp"))).toThrow();
  });

  it("reclaims a stale lock file left by a dead process", async () => {
    const lockFile = path.join(homeDir, "workspaces.json.lock");
    writeFileSync(lockFile, "");
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(lockFile, staleTime, staleTime);

    const entry = await registerWorkspace(workspaceDir, {}, { homeDir });
    expect(entry.path).toBe(workspaceDir);
  });

  it("serializes concurrent registrations of distinct directories, losing none", async () => {
    const dirs = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const dir = path.join(workspaceDir, `sub-${i}`);
        await mkdir(dir, { recursive: true });
        return realpath(dir);
      }),
    );

    await Promise.all(dirs.map((dir) => registerWorkspace(dir, {}, { homeDir })));

    const all = await listWorkspaces({ homeDir });
    expect(all.map((entry) => entry.path).sort()).toEqual([...dirs].sort());
  });
});

describe("listWorkspaces", () => {
  it("returns an empty array when nothing is registered", async () => {
    expect(await listWorkspaces({ homeDir })).toEqual([]);
  });

  it("returns registered entries in registration order", async () => {
    const second = path.join(workspaceDir, "second");
    await mkdir(second, { recursive: true });

    await registerWorkspace(workspaceDir, {}, { homeDir });
    await registerWorkspace(second, {}, { homeDir });

    const all = await listWorkspaces({ homeDir });
    expect(all.map((entry) => entry.path)).toEqual([workspaceDir, await realpath(second)]);
  });

  it("returns an empty array when workspaces.json is corrupt", async () => {
    writeFileSync(path.join(homeDir, "workspaces.json"), "{not json");
    expect(await listWorkspaces({ homeDir })).toEqual([]);
  });

  it("drops malformed entries but keeps well-formed ones", async () => {
    writeFileSync(
      path.join(homeDir, "workspaces.json"),
      JSON.stringify({
        schemaVersion: 1,
        workspaces: [
          { path: workspaceDir, registeredAt: "2026-01-01T00:00:00.000Z" },
          { path: 42, registeredAt: "2026-01-01T00:00:00.000Z" },
          { registeredAt: "2026-01-01T00:00:00.000Z" },
          "not-an-object",
        ],
      }),
    );
    const all = await listWorkspaces({ homeDir });
    expect(all).toEqual([{ path: workspaceDir, registeredAt: "2026-01-01T00:00:00.000Z" }]);
  });
});

describe("unregisterWorkspace", () => {
  it("removes a registered directory and returns true", async () => {
    await registerWorkspace(workspaceDir, {}, { homeDir });
    const removed = await unregisterWorkspace(workspaceDir, { homeDir });

    expect(removed).toBe(true);
    expect(await listWorkspaces({ homeDir })).toEqual([]);
  });

  it("returns false for a directory that was never registered", async () => {
    const removed = await unregisterWorkspace(workspaceDir, { homeDir });
    expect(removed).toBe(false);
  });

  it("only removes the targeted entry, leaving siblings intact", async () => {
    const second = path.join(workspaceDir, "second");
    await mkdir(second, { recursive: true });
    await registerWorkspace(workspaceDir, {}, { homeDir });
    await registerWorkspace(second, {}, { homeDir });

    await unregisterWorkspace(workspaceDir, { homeDir });

    const all = await listWorkspaces({ homeDir });
    expect(all.map((entry) => entry.path)).toEqual([await realpath(second)]);
  });
});

describe("resolveWorkspacePath", () => {
  it("resolves symlinks", async () => {
    const link = path.join(tmpdir(), `falcon-workspace-registry-resolve-link-${Date.now()}`);
    const { symlink, unlink } = await import("node:fs/promises");
    await symlink(workspaceDir, link);
    try {
      expect(await resolveWorkspacePath(link)).toBe(workspaceDir);
    } finally {
      await unlink(link).catch(() => {});
    }
  });

  it("falls back to path.resolve for a nonexistent directory", async () => {
    const missing = path.join(workspaceDir, "nope");
    expect(await resolveWorkspacePath(missing)).toBe(path.resolve(missing));
  });
});

describe("isWithinRegisteredWorkspace", () => {
  it("matches the registered root itself", async () => {
    await registerWorkspace(workspaceDir, { displayName: "root" }, { homeDir });
    const match = await isWithinRegisteredWorkspace(workspaceDir, { homeDir });
    expect(match?.path).toBe(workspaceDir);
  });

  it("matches a subdirectory of a registered root", async () => {
    const sub = path.join(workspaceDir, "a", "b");
    await mkdir(sub, { recursive: true });
    await registerWorkspace(workspaceDir, {}, { homeDir });

    const match = await isWithinRegisteredWorkspace(sub, { homeDir });
    expect(match?.path).toBe(workspaceDir);
  });

  it("returns null for a directory outside every registered root", async () => {
    await registerWorkspace(workspaceDir, {}, { homeDir });
    const outside = mkdtempSync(path.join(tmpdir(), "falcon-workspace-registry-outside-"));
    try {
      expect(await isWithinRegisteredWorkspace(outside, { homeDir })).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a sibling directory that merely shares a path prefix with a registered root", async () => {
    await registerWorkspace(workspaceDir, {}, { homeDir });
    const sibling = `${workspaceDir}-sibling`;
    await mkdir(sibling, { recursive: true });
    try {
      expect(await isWithinRegisteredWorkspace(sibling, { homeDir })).toBeNull();
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("returns null for a directory that doesn't exist", async () => {
    await registerWorkspace(workspaceDir, {}, { homeDir });
    expect(
      await isWithinRegisteredWorkspace(path.join(workspaceDir, "gone"), { homeDir }),
    ).toBeNull();
  });

  it("returns null when nothing is registered", async () => {
    expect(await isWithinRegisteredWorkspace(workspaceDir, { homeDir })).toBeNull();
  });
});
