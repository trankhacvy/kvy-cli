import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWorkspaces } from "../workspace/registry.js";
import {
  runWorkspaceListCommand,
  runWorkspaceRegisterCommand,
  runWorkspaceUnregisterCommand,
} from "./workspaceRegister.js";

let homeDir: string;
let workspaceDir: string;

beforeEach(async () => {
  homeDir = mkdtempSync(path.join(tmpdir(), "kvy-workspace-register-cmd-home-"));
  workspaceDir = await realpath(
    mkdtempSync(path.join(tmpdir(), "kvy-workspace-register-cmd-repo-")),
  );
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

function collectWrites() {
  const lines: string[] = [];
  return { write: (text: string) => lines.push(text), lines };
}

describe("runWorkspaceRegisterCommand", () => {
  it("registers --directory and reports success", async () => {
    const { write, lines } = collectWrites();

    const code = await runWorkspaceRegisterCommand(
      { directory: workspaceDir },
      { workingDirectory: "/unused", registryOptions: { homeDir }, write },
    );

    expect(code).toBe(0);
    expect(lines.join("")).toContain(`registered ${workspaceDir}`);
    const all = await listWorkspaces({ homeDir });
    expect(all).toHaveLength(1);
    expect(all[0]?.path).toBe(workspaceDir);
  });

  it("defaults --directory to workingDirectory", async () => {
    const { write } = collectWrites();
    await runWorkspaceRegisterCommand(
      {},
      { workingDirectory: workspaceDir, registryOptions: { homeDir }, write },
    );

    const all = await listWorkspaces({ homeDir });
    expect(all[0]?.path).toBe(workspaceDir);
  });

  it("stores --name as displayName and shows it in the output", async () => {
    const { write, lines } = collectWrites();
    await runWorkspaceRegisterCommand(
      { directory: workspaceDir, name: "My Repo" },
      { workingDirectory: "/unused", registryOptions: { homeDir }, write },
    );

    expect(lines.join("")).toContain('"My Repo"');
    const all = await listWorkspaces({ homeDir });
    expect(all[0]?.displayName).toBe("My Repo");
  });
});

describe("runWorkspaceListCommand", () => {
  it("reports no registered workspaces when the registry is empty", async () => {
    const { write, lines } = collectWrites();
    const code = await runWorkspaceListCommand({
      workingDirectory: "/unused",
      registryOptions: { homeDir },
      write,
    });

    expect(code).toBe(0);
    expect(lines.join("")).toContain("no registered workspaces");
  });

  it("lists every registered workspace", async () => {
    await runWorkspaceRegisterCommand(
      { directory: workspaceDir, name: "repo" },
      { workingDirectory: "/unused", registryOptions: { homeDir } },
    );

    const { write, lines } = collectWrites();
    await runWorkspaceListCommand({
      workingDirectory: "/unused",
      registryOptions: { homeDir },
      write,
    });

    expect(lines.join("")).toContain(workspaceDir);
    expect(lines.join("")).toContain("repo");
  });
});

describe("runWorkspaceUnregisterCommand", () => {
  it("removes a registered directory and returns 0", async () => {
    await runWorkspaceRegisterCommand(
      { directory: workspaceDir },
      { workingDirectory: "/unused", registryOptions: { homeDir } },
    );

    const { write, lines } = collectWrites();
    const code = await runWorkspaceUnregisterCommand(
      { directory: workspaceDir },
      { workingDirectory: "/unused", registryOptions: { homeDir }, write },
    );

    expect(code).toBe(0);
    expect(lines.join("")).toContain(`removed ${workspaceDir}`);
    expect(await listWorkspaces({ homeDir })).toEqual([]);
  });

  it("returns 1 and reports a no-op for a directory that was never registered", async () => {
    const { write, lines } = collectWrites();
    const code = await runWorkspaceUnregisterCommand(
      { directory: workspaceDir },
      { workingDirectory: "/unused", registryOptions: { homeDir }, write },
    );

    expect(code).toBe(1);
    expect(lines.join("")).toContain("was not registered");
  });

  it("defaults --directory to workingDirectory", async () => {
    await runWorkspaceRegisterCommand(
      {},
      { workingDirectory: workspaceDir, registryOptions: { homeDir } },
    );

    const code = await runWorkspaceUnregisterCommand(
      {},
      { workingDirectory: workspaceDir, registryOptions: { homeDir } },
    );

    expect(code).toBe(0);
    expect(await listWorkspaces({ homeDir })).toEqual([]);
  });
});
