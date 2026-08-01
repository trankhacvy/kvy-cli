import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWorkspace } from "../workspace/registry.js";
import { setWorkspaceGitConfig } from "../workspaceConfig.js";
import { RunProcessError } from "./runProcess.js";
import { handleWorkspaceGetConfig, handleWorkspaceSetConfig } from "./workspaceConfigRpc.js";

let homeDir: string;
let workspaceRoot: string;

beforeEach(async () => {
  homeDir = mkdtempSync(path.join(tmpdir(), "kvy-workspace-config-rpc-test-home-"));
  workspaceRoot = await realpath(
    mkdtempSync(path.join(tmpdir(), "kvy-workspace-config-rpc-test-repo-")),
  );
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("handleWorkspaceGetConfig", () => {
  it("throws RunProcessError for an unregistered worktree", async () => {
    await expect(
      handleWorkspaceGetConfig({ idempotencyKey: "k1", worktree: workspaceRoot }, { homeDir }),
    ).rejects.toThrow(RunProcessError);
  });

  it("returns an empty object when the workspace has no config yet", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    const result = await handleWorkspaceGetConfig(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      { homeDir },
    );
    expect(result).toEqual({
      baseRef: undefined,
      remote: undefined,
      setupScript: undefined,
      runScript: undefined,
    });
  });

  it("returns the full configured shape", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    await setWorkspaceGitConfig(
      workspaceRoot,
      { baseRef: "main", remote: "origin", setupScript: "npm install", runScript: "npm run dev" },
      { homeDir },
    );

    const result = await handleWorkspaceGetConfig(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      { homeDir },
    );

    expect(result).toEqual({
      baseRef: "main",
      remote: "origin",
      setupScript: "npm install",
      runScript: "npm run dev",
    });
  });

  it("never carries a script string as an RPC PARAM — only reads it back off the workspace's own config", async () => {
    // Structural check: WorkspaceGetConfigParams has exactly idempotencyKey/worktree.
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    await setWorkspaceGitConfig(workspaceRoot, { runScript: "npm run dev" }, { homeDir });
    const params = { idempotencyKey: "k1", worktree: workspaceRoot };
    expect(Object.keys(params).sort()).toEqual(["idempotencyKey", "worktree"]);
    await handleWorkspaceGetConfig(params, { homeDir });
  });
});

describe("handleWorkspaceSetConfig", () => {
  it("throws RunProcessError for an unregistered worktree", async () => {
    await expect(
      handleWorkspaceSetConfig(
        { idempotencyKey: "k1", worktree: workspaceRoot, baseRef: "main" },
        { homeDir },
      ),
    ).rejects.toThrow(RunProcessError);
  });

  it("writes baseRef/remote and returns the updated subset", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    const result = await handleWorkspaceSetConfig(
      { idempotencyKey: "k1", worktree: workspaceRoot, baseRef: "main", remote: "origin" },
      { homeDir },
    );
    expect(result).toEqual({ baseRef: "main", remote: "origin" });

    const readBack = await handleWorkspaceGetConfig(
      { idempotencyKey: "k1", worktree: workspaceRoot },
      { homeDir },
    );
    expect(readBack).toEqual({
      baseRef: "main",
      remote: "origin",
      setupScript: undefined,
      runScript: undefined,
    });
  });

  it("merges a partial patch, leaving unspecified fields untouched", async () => {
    await registerWorkspace(workspaceRoot, {}, { homeDir });
    await setWorkspaceGitConfig(workspaceRoot, { baseRef: "main", remote: "origin" }, { homeDir });

    const result = await handleWorkspaceSetConfig(
      { idempotencyKey: "k1", worktree: workspaceRoot, remote: "upstream" },
      { homeDir },
    );
    expect(result).toEqual({ baseRef: "main", remote: "upstream" });
  });

  it("never accepts a script string — WorkspaceSetConfigParams has exactly idempotencyKey/worktree/baseRef/remote", async () => {
    const params = {
      idempotencyKey: "k1",
      worktree: workspaceRoot,
      baseRef: "main",
      remote: "origin",
    };
    expect(Object.keys(params).sort()).toEqual(["baseRef", "idempotencyKey", "remote", "worktree"]);
  });
});
