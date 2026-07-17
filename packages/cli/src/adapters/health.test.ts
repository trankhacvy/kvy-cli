import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAdapterHealth, checkAllAdaptersHealth } from "./health.js";
import { ADAPTER_MANIFEST } from "./manifest.js";
import { adapterEntryPath, installedLockPath } from "./paths.js";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "falcon-adapters-health-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

async function installFixture(id: "claude-code" | "codex") {
  const entry = ADAPTER_MANIFEST[id];
  const lockPath = installedLockPath(homeDir);
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(
    lockPath,
    JSON.stringify({
      packages: {
        [`node_modules/${entry.packageName}`]: {
          version: entry.version,
          integrity: entry.integrity,
        },
      },
    }),
    "utf8",
  );
  const entryPath = adapterEntryPath(id, homeDir);
  await mkdir(path.dirname(entryPath), { recursive: true });
  await writeFile(entryPath, "// fake\n", "utf8");
}

describe("checkAdapterHealth", () => {
  it("reports status ok with the pinned version/package name once installed and verified", async () => {
    await installFixture("claude-code");

    const health = await checkAdapterHealth("claude-code", homeDir);
    expect(health).toEqual({
      id: "claude-code",
      label: "Claude Code",
      packageName: "@agentclientprotocol/claude-agent-acp",
      pinnedVersion: ADAPTER_MANIFEST["claude-code"].version,
      status: "ok",
    });
  });

  it("reports not-installed with no detail when nothing is on disk", async () => {
    const health = await checkAdapterHealth("codex", homeDir);
    expect(health.status).toBe("not-installed");
    expect(health.detail).toBeUndefined();
  });
});

describe("checkAllAdaptersHealth", () => {
  it("reports one entry per manifest adapter, independently", async () => {
    await installFixture("claude-code");

    const results = await checkAllAdaptersHealth(homeDir);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.id === "claude-code")?.status).toBe("ok");
    expect(results.find((r) => r.id === "codex")?.status).toBe("not-installed");
  });
});
