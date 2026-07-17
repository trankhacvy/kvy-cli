import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installShim } from "./install.js";

let homeDir: string;
let userHomeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-shim-install-home-"));
  userHomeDir = mkdtempSync(path.join(tmpdir(), "falcon-shim-install-user-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(userHomeDir, { recursive: true, force: true });
});

describe("installShim", () => {
  it("writes executable claude and codex shims that exec falcon", async () => {
    const result = await installShim({ homeDir, userHomeDir, env: {} });

    expect(result.installedBinaries).toHaveLength(2);
    for (const binaryPath of result.installedBinaries) {
      const content = readFileSync(binaryPath, "utf8");
      expect(content).toContain("#!/usr/bin/env sh");
      expect(content).toMatch(/exec falcon (claude|codex) "\$@"/);
      const mode = statSync(binaryPath).mode & 0o777;
      expect(mode).toBe(0o755);
    }
  });

  it("appends the PATH block to .profile when $SHELL is unset", async () => {
    const result = await installShim({ homeDir, userHomeDir, env: {} });

    expect(result.rcFile).toBe(path.join(userHomeDir, ".profile"));
    expect(result.rcFileUpdated).toBe(true);
    const content = readFileSync(result.rcFile, "utf8");
    expect(content).toContain("# >>> falcon shell shim >>>");
    expect(content).toContain('export PATH="$HOME/.falcon/bin:$PATH"');
  });

  it("preserves pre-existing rc file content", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(userHomeDir, ".profile"), "export EXISTING=1\n");

    const result = await installShim({ homeDir, userHomeDir, env: {} });

    const content = readFileSync(result.rcFile, "utf8");
    expect(content.startsWith("export EXISTING=1\n")).toBe(true);
    expect(content).toContain("# >>> falcon shell shim >>>");
  });

  it("is idempotent — a second install does not duplicate the PATH block", async () => {
    await installShim({ homeDir, userHomeDir, env: {} });
    const second = await installShim({ homeDir, userHomeDir, env: {} });

    expect(second.rcFileUpdated).toBe(false);
    const content = readFileSync(second.rcFile, "utf8");
    expect(content.split("# >>> falcon shell shim >>>")).toHaveLength(2);
  });

  it("picks .zshrc when $SHELL is zsh", async () => {
    const result = await installShim({ homeDir, userHomeDir, env: { SHELL: "/bin/zsh" } });
    expect(result.rcFile).toBe(path.join(userHomeDir, ".zshrc"));
  });
});
