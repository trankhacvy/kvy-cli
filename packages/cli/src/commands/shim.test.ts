import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runShimCommand } from "./shim.js";

let homeDir: string;
let userHomeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-shim-cmd-home-"));
  userHomeDir = mkdtempSync(path.join(tmpdir(), "falcon-shim-cmd-user-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(userHomeDir, { recursive: true, force: true });
});

function collectWrites() {
  const lines: string[] = [];
  return { write: (text: string) => lines.push(text), lines };
}

describe("runShimCommand", () => {
  it("install: prints installed binaries and the rc file that was updated", async () => {
    const { write, lines } = collectWrites();

    const code = await runShimCommand("install", {
      shimOptions: { homeDir, userHomeDir, env: {} },
      write,
    });

    expect(code).toBe(0);
    const output = lines.join("");
    expect(output).toContain("Installed shims:");
    expect(output).toContain(path.join(userHomeDir, ".profile"));
  });

  it("status: reports not-installed before install runs", async () => {
    const { write, lines } = collectWrites();

    const code = await runShimCommand("status", {
      shimOptions: { homeDir, userHomeDir, env: { PATH: "/usr/bin" } },
      write,
    });

    expect(code).toBe(0);
    const output = lines.join("");
    expect(output).toContain("installed:   (none)");
    expect(output).toContain("PATH block:  (not configured)");
  });

  it("status: reports installed after install runs", async () => {
    await runShimCommand("install", { shimOptions: { homeDir, userHomeDir, env: {} } });
    const { write, lines } = collectWrites();

    await runShimCommand("status", {
      shimOptions: { homeDir, userHomeDir, env: { PATH: "/usr/bin" } },
      write,
    });

    const output = lines.join("");
    expect(output).toContain("claude");
    expect(output).toContain("codex");
    expect(output).not.toContain("installed:   (none)");
  });

  it("uninstall: removes shims and reports what was removed", async () => {
    await runShimCommand("install", { shimOptions: { homeDir, userHomeDir, env: {} } });
    const { write, lines } = collectWrites();

    const code = await runShimCommand("uninstall", {
      shimOptions: { homeDir, userHomeDir, env: {} },
      write,
    });

    expect(code).toBe(0);
    const output = lines.join("");
    expect(output).toContain("Removed shims:");
    expect(output).toContain("Removed the Falcon PATH block from:");
  });

  it("uninstall: reports nothing-to-do when never installed", async () => {
    const { write, lines } = collectWrites();

    await runShimCommand("uninstall", { shimOptions: { homeDir, userHomeDir, env: {} }, write });

    const output = lines.join("");
    expect(output).toContain("No shims were installed.");
    expect(output).toContain("No rc files had a Falcon PATH block.");
  });
});
