import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWorkspace } from "../workspace/registry.js";
import { GitExecError } from "./gitExec.js";
import { createRegistryWorktreeAuthorizer } from "./gitWriteGuard.js";

let homeDir: string;
let workspaceDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-git-write-guard-home-"));
  workspaceDir = realpathSync(mkdtempSync(path.join(tmpdir(), "falcon-git-write-guard-repo-")));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("createRegistryWorktreeAuthorizer", () => {
  it("resolves for a registered path", async () => {
    await registerWorkspace(workspaceDir, {}, { homeDir });
    const authorize = createRegistryWorktreeAuthorizer({ homeDir });
    await expect(authorize(workspaceDir)).resolves.toBeUndefined();
  });

  it("resolves for a directory nested under a registered path", async () => {
    const nested = path.join(workspaceDir, ".worktrees", "wf-foo");
    await mkdir(nested, { recursive: true });
    await registerWorkspace(workspaceDir, {}, { homeDir });

    const authorize = createRegistryWorktreeAuthorizer({ homeDir });
    await expect(authorize(nested)).resolves.toBeUndefined();
  });

  it("throws a GitExecError for an unregistered path", async () => {
    const authorize = createRegistryWorktreeAuthorizer({ homeDir });
    await expect(authorize(workspaceDir)).rejects.toThrow(GitExecError);
  });

  it("throws a GitExecError for a nonexistent path", async () => {
    const authorize = createRegistryWorktreeAuthorizer({ homeDir });
    await expect(authorize(path.join(workspaceDir, "does-not-exist"))).rejects.toThrow(
      GitExecError,
    );
  });
});
