import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTranscriptIndexerWorkspaceLister, createWorkspaceRootLookup } from "./adapters.js";
import { registerWorkspace } from "./registry.js";

let homeDir: string;
let workspaceDir: string;

beforeEach(async () => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-workspace-adapters-home-"));
  workspaceDir = await realpath(
    mkdtempSync(path.join(tmpdir(), "falcon-workspace-adapters-repo-")),
  );
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("createWorkspaceRootLookup", () => {
  it("resolves a registered workspaceId (its own path) back to itself", async () => {
    await registerWorkspace(workspaceDir, {}, { homeDir });
    const lookup = createWorkspaceRootLookup({ homeDir });

    expect(await lookup(workspaceDir)).toBe(workspaceDir);
  });

  it("returns null for an unregistered workspaceId", async () => {
    const lookup = createWorkspaceRootLookup({ homeDir });
    expect(await lookup(workspaceDir)).toBeNull();
  });
});

describe("createTranscriptIndexerWorkspaceLister", () => {
  it("returns an empty list when nothing is registered", async () => {
    const list = createTranscriptIndexerWorkspaceLister({ homeDir });
    expect(await list()).toEqual([]);
  });

  it("maps every registered entry to {workspaceId, path} using the path as the id", async () => {
    await registerWorkspace(workspaceDir, { displayName: "repo" }, { homeDir });
    const list = createTranscriptIndexerWorkspaceLister({ homeDir });

    expect(await list()).toEqual([{ workspaceId: workspaceDir, path: workspaceDir }]);
  });

  it("reflects registry changes on each call (no stale caching)", async () => {
    const list = createTranscriptIndexerWorkspaceLister({ homeDir });
    expect(await list()).toEqual([]);

    await registerWorkspace(workspaceDir, {}, { homeDir });
    expect(await list()).toEqual([{ workspaceId: workspaceDir, path: workspaceDir }]);
  });
});
