import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADAPTER_MANIFEST } from "./manifest.js";
import { adapterEntryPath, installedLockPath } from "./paths.js";
import { resolveAdapterSpawn } from "./spawn.js";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "kvy-adapters-spawn-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe("resolveAdapterSpawn", () => {
  it("refuses to spawn when the adapter isn't installed", async () => {
    const result = await resolveAdapterSpawn("claude-code", homeDir);
    expect(result).toEqual({ ok: false, reason: "not-installed" });
  });

  it("resolves node + the verified entrypoint when the install is valid", async () => {
    const entry = ADAPTER_MANIFEST["claude-code"];
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
    const entryPath = adapterEntryPath("claude-code", homeDir);
    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(entryPath, "// fake\n", "utf8");

    const result = await resolveAdapterSpawn("claude-code", homeDir, "/usr/bin/node");
    expect(result).toEqual({ ok: true, spec: { command: "/usr/bin/node", args: [entryPath] } });
  });
});
