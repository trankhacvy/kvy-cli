import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkspaceGitConfig } from "../workspaceConfig.js";
import { runWorkspaceConfigCommand } from "./workspaceConfig.js";

let homeDir: string;
let workspaceDir: string;

beforeEach(async () => {
  homeDir = mkdtempSync(path.join(tmpdir(), "kvy-workspace-config-cmd-home-"));
  workspaceDir = await realpath(mkdtempSync(path.join(tmpdir(), "kvy-workspace-config-cmd-repo-")));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

function collectWrites() {
  const lines: string[] = [];
  return { write: (text: string) => lines.push(text), lines };
}

describe("runWorkspaceConfigCommand", () => {
  it("sets baseRef and prints the resulting config", async () => {
    const { write, lines } = collectWrites();

    const code = await runWorkspaceConfigCommand(
      { baseRef: "develop", directory: workspaceDir },
      { workingDirectory: "/unused", persistenceOptions: { homeDir }, write },
    );

    expect(code).toBe(0);
    expect(lines.join("")).toContain("base ref:     develop");
    expect(lines.join("")).toContain("remote:       (none)");
    expect(lines.join("")).toContain("setup script: (none)");
    expect(lines.join("")).toContain("run script:   (none)");
    expect(await readWorkspaceGitConfig(workspaceDir, { homeDir })).toEqual({
      baseRef: "develop",
    });
  });

  it("sets remote independently and preserves a previously-set baseRef", async () => {
    const { write } = collectWrites();
    await runWorkspaceConfigCommand(
      { baseRef: "main", directory: workspaceDir },
      { workingDirectory: "/unused", persistenceOptions: { homeDir }, write },
    );

    const { write: write2, lines } = collectWrites();
    await runWorkspaceConfigCommand(
      { remote: "upstream", directory: workspaceDir },
      { workingDirectory: "/unused", persistenceOptions: { homeDir }, write: write2 },
    );

    expect(lines.join("")).toContain("base ref:     main");
    expect(lines.join("")).toContain("remote:       upstream");
  });

  it("defaults --directory to workingDirectory", async () => {
    const { write, lines } = collectWrites();

    await runWorkspaceConfigCommand(
      { baseRef: "main" },
      { workingDirectory: workspaceDir, persistenceOptions: { homeDir }, write },
    );

    expect(lines.join("")).toContain(workspaceDir);
    expect(await readWorkspaceGitConfig(workspaceDir, { homeDir })).toEqual({ baseRef: "main" });
  });

  it("with no --base-ref/--remote/--setup-script/--run-script, reads back the current config without writing", async () => {
    const { write: write1 } = collectWrites();
    await runWorkspaceConfigCommand(
      { baseRef: "main", remote: "origin", directory: workspaceDir },
      { workingDirectory: "/unused", persistenceOptions: { homeDir }, write: write1 },
    );

    const { write: write2, lines } = collectWrites();
    const code = await runWorkspaceConfigCommand(
      { directory: workspaceDir },
      { workingDirectory: "/unused", persistenceOptions: { homeDir }, write: write2 },
    );

    expect(code).toBe(0);
    expect(lines.join("")).toContain("base ref:     main");
    expect(lines.join("")).toContain("remote:       origin");
  });

  it("prints (none) for every field on an unconfigured workspace", async () => {
    const { write, lines } = collectWrites();

    await runWorkspaceConfigCommand(
      { directory: workspaceDir },
      { workingDirectory: "/unused", persistenceOptions: { homeDir }, write },
    );

    expect(lines.join("")).toContain("base ref:     (none)");
    expect(lines.join("")).toContain("remote:       (none)");
    expect(lines.join("")).toContain("setup script: (none)");
    expect(lines.join("")).toContain("run script:   (none)");
  });

  it("sets setupScript/runScript and prints them", async () => {
    const { write, lines } = collectWrites();

    const code = await runWorkspaceConfigCommand(
      { setupScript: "npm install", runScript: "npm run dev", directory: workspaceDir },
      { workingDirectory: "/unused", persistenceOptions: { homeDir }, write },
    );

    expect(code).toBe(0);
    expect(lines.join("")).toContain("setup script: npm install");
    expect(lines.join("")).toContain("run script:   npm run dev");
    expect(await readWorkspaceGitConfig(workspaceDir, { homeDir })).toEqual({
      setupScript: "npm install",
      runScript: "npm run dev",
    });
  });

  it('clears a previously-set runScript via --run-script ""', async () => {
    const { write: write1 } = collectWrites();
    await runWorkspaceConfigCommand(
      { setupScript: "npm install", runScript: "npm run dev", directory: workspaceDir },
      { workingDirectory: "/unused", persistenceOptions: { homeDir }, write: write1 },
    );

    const { write: write2, lines } = collectWrites();
    await runWorkspaceConfigCommand(
      { runScript: "", directory: workspaceDir },
      { workingDirectory: "/unused", persistenceOptions: { homeDir }, write: write2 },
    );

    expect(lines.join("")).toContain("setup script: npm install");
    expect(lines.join("")).toContain("run script:   (none)");
    expect(await readWorkspaceGitConfig(workspaceDir, { homeDir })).toEqual({
      setupScript: "npm install",
    });
  });
});
