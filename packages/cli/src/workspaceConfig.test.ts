import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkspaceGitConfig, setWorkspaceGitConfig } from "./workspaceConfig.js";

let homeDir: string;
let workspaceDir: string;

beforeEach(async () => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-workspace-config-test-home-"));
  const raw = mkdtempSync(path.join(tmpdir(), "falcon-workspace-config-test-repo-"));
  workspaceDir = await realpath(raw);
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("readWorkspaceGitConfig", () => {
  it("returns null when nothing has been configured", async () => {
    expect(await readWorkspaceGitConfig(workspaceDir, { homeDir })).toBeNull();
  });

  it("returns null for an unrelated directory once one workspace is configured", async () => {
    await setWorkspaceGitConfig(workspaceDir, { baseRef: "main" }, { homeDir });
    const other = mkdtempSync(path.join(tmpdir(), "falcon-workspace-config-test-other-"));
    try {
      expect(await readWorkspaceGitConfig(other, { homeDir })).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("setWorkspaceGitConfig", () => {
  it("persists baseRef/remote and reads them back", async () => {
    const result = await setWorkspaceGitConfig(
      workspaceDir,
      { baseRef: "develop", remote: "origin" },
      { homeDir },
    );
    expect(result).toEqual({ baseRef: "develop", remote: "origin" });
    expect(await readWorkspaceGitConfig(workspaceDir, { homeDir })).toEqual({
      baseRef: "develop",
      remote: "origin",
    });
  });

  it("merges a partial patch, leaving previously-set fields intact", async () => {
    await setWorkspaceGitConfig(workspaceDir, { baseRef: "main", remote: "origin" }, { homeDir });
    const result = await setWorkspaceGitConfig(workspaceDir, { baseRef: "develop" }, { homeDir });
    expect(result).toEqual({ baseRef: "develop", remote: "origin" });
  });

  it("keys by real path, so a symlinked directory resolves to the same config", async () => {
    await setWorkspaceGitConfig(workspaceDir, { baseRef: "main" }, { homeDir });

    const linkParent = mkdtempSync(path.join(tmpdir(), "falcon-workspace-config-test-link-"));
    const link = path.join(linkParent, "repo-link");
    const { symlink } = await import("node:fs/promises");
    await symlink(workspaceDir, link);
    try {
      expect(await readWorkspaceGitConfig(link, { homeDir })).toEqual({ baseRef: "main" });
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it("falls back to the plain absolute path when the directory doesn't exist", async () => {
    const missing = path.join(workspaceDir, "does-not-exist");
    await setWorkspaceGitConfig(missing, { baseRef: "main" }, { homeDir });
    expect(await readWorkspaceGitConfig(missing, { homeDir })).toEqual({ baseRef: "main" });

    await mkdir(missing);
    // Once the directory exists, realpath resolves it — same key here since
    // there's no symlink indirection, so the config is still found.
    expect(await readWorkspaceGitConfig(missing, { homeDir })).toEqual({ baseRef: "main" });
  });

  it("persists setupScript/runScript and reads them back (docs/features/setup-run-scripts.md)", async () => {
    const result = await setWorkspaceGitConfig(
      workspaceDir,
      { setupScript: "npm install", runScript: "npm run dev" },
      { homeDir },
    );
    expect(result).toEqual({ setupScript: "npm install", runScript: "npm run dev" });
    expect(await readWorkspaceGitConfig(workspaceDir, { homeDir })).toEqual({
      setupScript: "npm install",
      runScript: "npm run dev",
    });
  });

  it("a patch field set to the empty string deletes that key entirely (clear semantics)", async () => {
    await setWorkspaceGitConfig(
      workspaceDir,
      { baseRef: "main", setupScript: "npm install", runScript: "npm run dev" },
      { homeDir },
    );

    const cleared = await setWorkspaceGitConfig(workspaceDir, { runScript: "" }, { homeDir });
    expect(cleared).toEqual({ baseRef: "main", setupScript: "npm install" });
    expect(await readWorkspaceGitConfig(workspaceDir, { homeDir })).toEqual({
      baseRef: "main",
      setupScript: "npm install",
    });
  });

  it("omitting a field from the patch entirely leaves it untouched (not cleared)", async () => {
    await setWorkspaceGitConfig(workspaceDir, { setupScript: "npm install" }, { homeDir });
    const result = await setWorkspaceGitConfig(workspaceDir, { baseRef: "main" }, { homeDir });
    expect(result).toEqual({ baseRef: "main", setupScript: "npm install" });
  });
});
