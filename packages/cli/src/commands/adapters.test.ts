import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAdaptersInstallCommand, runAdaptersUpgradeCommand } from "./adapters.js";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "falcon-adapters-cmd-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

function collectWrites() {
  const lines: string[] = [];
  return { write: (text: string) => lines.push(text), lines };
}

function fakeRunNpm() {
  return vi.fn(async (_args: string[], _cwd: string) => {
    throw new Error("registry unreachable in test");
  });
}

describe("runAdaptersInstallCommand", () => {
  it("reports a failure per adapter and returns 1 when npm can't reach the registry", async () => {
    const { write, lines } = collectWrites();
    const runNpm = fakeRunNpm();

    const code = await runAdaptersInstallCommand({ homeDir, installDeps: { runNpm }, write });

    expect(code).toBe(1);
    const output = lines.join("");
    expect(output).toContain("falcon adapters install:");
    expect(output).toContain("claude-code: FAILED");
    expect(output).toContain("codex: FAILED");
  });

  it("reports success for both adapters when npm succeeds", async () => {
    const runNpm = vi.fn(async (args: string[], cwd: string) => {
      const spec = args[1] as string;
      const at = spec.lastIndexOf("@");
      const pkgName = spec.slice(0, at);
      const version = spec.slice(at + 1);
      const fs = await import("node:fs/promises");
      const lockPath = path.join(cwd, "node_modules", ".package-lock.json");
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      const { ADAPTER_MANIFEST } = await import("../adapters/manifest.js");
      const entry = Object.values(ADAPTER_MANIFEST).find((e) => e.packageName === pkgName);
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          packages: { [`node_modules/${pkgName}`]: { version, integrity: entry?.integrity } },
        }),
        "utf8",
      );
      if (entry) {
        const entryFile = path.join(cwd, "node_modules", ...pkgName.split("/"), entry.binEntry);
        await fs.mkdir(path.dirname(entryFile), { recursive: true });
        await fs.writeFile(entryFile, "// fake\n", "utf8");
      }
    });

    const { write, lines } = collectWrites();
    const code = await runAdaptersInstallCommand({ homeDir, installDeps: { runNpm }, write });

    expect(code).toBe(0);
    const output = lines.join("");
    expect(output).toContain("claude-code: installed");
    expect(output).toContain("codex: installed");
  });
});

describe("runAdaptersUpgradeCommand", () => {
  it("forces a reinstall via installAllAdapters with force: true", async () => {
    const runNpm = fakeRunNpm();
    const { write } = collectWrites();

    const code = await runAdaptersUpgradeCommand({ homeDir, installDeps: { runNpm }, write });

    expect(code).toBe(1);
    expect(runNpm).toHaveBeenCalled();
  });
});
