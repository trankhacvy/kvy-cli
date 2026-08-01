import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertWorkspaceStillValid,
  validateSpawnWorkspace,
  WorkspaceValidationError,
} from "./workspacePath.js";

describe("validateSpawnWorkspace", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "kvy-workspace-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a directory equal to the registered workspace root", async () => {
    const result = await validateSpawnWorkspace(
      { workspaceId: "ws_1", directory: root },
      () => root,
    );
    expect(result).toEqual({ ok: true, realDirectory: await realpath(root) });
  });

  it("accepts a subdirectory of the registered workspace root", async () => {
    const sub = path.join(root, "sub", "dir");
    await mkdir(sub, { recursive: true });

    const result = await validateSpawnWorkspace(
      { workspaceId: "ws_1", directory: sub },
      () => root,
    );
    expect(result).toEqual({ ok: true, realDirectory: await realpath(sub) });
  });

  it("rejects a relative directory outright", async () => {
    const result = await validateSpawnWorkspace(
      { workspaceId: "ws_1", directory: "relative/path" },
      () => root,
    );
    expect(result).toEqual({ ok: false, reason: "not-absolute" });
  });

  it("rejects when the workspaceId has no registered root", async () => {
    const result = await validateSpawnWorkspace(
      { workspaceId: "ws_unknown", directory: root },
      () => null,
    );
    expect(result).toEqual({ ok: false, reason: "unknown-workspace" });
  });

  it("rejects a nonexistent directory", async () => {
    const result = await validateSpawnWorkspace(
      { workspaceId: "ws_1", directory: path.join(root, "does-not-exist") },
      () => root,
    );
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("rejects a file (not a directory)", async () => {
    const filePath = path.join(root, "afile.txt");
    await writeFile(filePath, "hi");

    const result = await validateSpawnWorkspace(
      { workspaceId: "ws_1", directory: filePath },
      () => root,
    );
    expect(result).toEqual({ ok: false, reason: "not-directory" });
  });

  it("rejects a sibling directory that merely shares a path prefix with the root", async () => {
    const sibling = `${root}-sibling`;
    await mkdir(sibling, { recursive: true });
    try {
      const result = await validateSpawnWorkspace(
        { workspaceId: "ws_1", directory: sibling },
        () => root,
      );
      expect(result).toEqual({ ok: false, reason: "outside-workspace-root" });
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("rejects a symlink that escapes the registered root, even though the link itself lives inside it", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "kvy-outside-"));
    const link = path.join(root, "escape");
    await symlink(outside, link);

    try {
      const result = await validateSpawnWorkspace(
        { workspaceId: "ws_1", directory: link },
        () => root,
      );
      expect(result).toEqual({ ok: false, reason: "outside-workspace-root" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects when the registered root itself no longer exists", async () => {
    const missingRoot = path.join(root, "gone");
    const result = await validateSpawnWorkspace(
      { workspaceId: "ws_1", directory: root },
      () => missingRoot,
    );
    expect(result).toEqual({ ok: false, reason: "unknown-workspace" });
  });

  it("supports an async lookupRoot", async () => {
    const result = await validateSpawnWorkspace(
      { workspaceId: "ws_1", directory: root },
      async () => root,
    );
    expect(result.ok).toBe(true);
  });
});

describe("assertWorkspaceStillValid (known-issues.md #3)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "kvy-workspace-valid-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves without throwing for an existing directory that is a git repo", async () => {
    await mkdir(path.join(root, ".git"), { recursive: true });
    await expect(assertWorkspaceStillValid(root)).resolves.toBeUndefined();
  });

  it("throws workspace-missing for a directory that no longer exists (renamed/moved/deleted)", async () => {
    const gone = path.join(root, "gone");
    await expect(assertWorkspaceStillValid(gone)).rejects.toBeInstanceOf(WorkspaceValidationError);
    await expect(assertWorkspaceStillValid(gone)).rejects.toMatchObject({
      code: "workspace-missing",
    });
  });

  it("throws workspace-missing when the path is a file, not a directory", async () => {
    const filePath = path.join(root, "afile.txt");
    await writeFile(filePath, "hi");
    await expect(assertWorkspaceStillValid(filePath)).rejects.toMatchObject({
      code: "workspace-missing",
    });
  });

  it("throws workspace-not-a-repo when the directory exists but has no .git", async () => {
    await expect(assertWorkspaceStillValid(root)).rejects.toMatchObject({
      code: "workspace-not-a-repo",
    });
  });
});
