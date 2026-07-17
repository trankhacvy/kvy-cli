import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installShim } from "./install.js";
import { shimBinaryPath } from "./paths.js";
import { uninstallShim } from "./uninstall.js";

let homeDir: string;
let userHomeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-shim-uninstall-home-"));
  userHomeDir = mkdtempSync(path.join(tmpdir(), "falcon-shim-uninstall-user-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(userHomeDir, { recursive: true, force: true });
});

describe("uninstallShim", () => {
  it("removes shim binaries and the PATH block after install", async () => {
    await installShim({ homeDir, userHomeDir, env: {} });

    const result = await uninstallShim({ homeDir, userHomeDir, env: {} });

    expect(result.removedBinaries).toHaveLength(2);
    expect(existsSync(shimBinaryPath("claude", { homeDir }))).toBe(false);
    expect(existsSync(shimBinaryPath("codex", { homeDir }))).toBe(false);
    expect(result.updatedRcFiles).toEqual([path.join(userHomeDir, ".profile")]);
    const content = readFileSync(path.join(userHomeDir, ".profile"), "utf8");
    expect(content).not.toContain("falcon shell shim");
  });

  it("is a no-op when nothing was installed", async () => {
    const result = await uninstallShim({ homeDir, userHomeDir, env: {} });
    expect(result.removedBinaries).toEqual([]);
    expect(result.updatedRcFiles).toEqual([]);
  });

  it("strips the block from every rc file that has it, not just the preferred one", async () => {
    await installShim({ homeDir, userHomeDir, env: { SHELL: "/bin/zsh" } });
    // Simulate a shell switch: install also touched .zshrc; manually add the
    // block to .bashrc too, to prove uninstall scans every candidate.
    await installShim({ homeDir, userHomeDir, env: { SHELL: "/bin/bash" } });

    const result = await uninstallShim({ homeDir, userHomeDir, env: {} });

    expect(result.updatedRcFiles.sort()).toEqual(
      [path.join(userHomeDir, ".zshrc"), path.join(userHomeDir, ".bashrc")].sort(),
    );
  });

  it("preserves unrelated rc file content", async () => {
    writeFileSync(path.join(userHomeDir, ".profile"), "export EXISTING=1\n");
    await installShim({ homeDir, userHomeDir, env: {} });

    await uninstallShim({ homeDir, userHomeDir, env: {} });

    const content = readFileSync(path.join(userHomeDir, ".profile"), "utf8");
    expect(content).toBe("export EXISTING=1\n");
  });
});
