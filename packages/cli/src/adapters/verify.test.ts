import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADAPTER_MANIFEST } from "./manifest.js";
import { adapterEntryPath, adapterPackageDir, installedLockPath } from "./paths.js";
import { verifyAdapterInstall } from "./verify.js";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "kvy-adapters-verify-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

async function writeLock(overrides: Record<string, unknown> = {}) {
  const entry = ADAPTER_MANIFEST["claude-code"];
  const lockPath = installedLockPath(homeDir);
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(
    lockPath,
    JSON.stringify({
      name: "kvy-adapters",
      lockfileVersion: 3,
      packages: {
        [`node_modules/${entry.packageName}`]: {
          version: entry.version,
          integrity: entry.integrity,
          ...overrides,
        },
      },
    }),
    "utf8",
  );
}

async function writeEntryFile() {
  const entryPath = adapterEntryPath("claude-code", homeDir);
  await mkdir(path.dirname(entryPath), { recursive: true });
  await writeFile(entryPath, "// fake acp entrypoint\n", "utf8");
}

describe("verifyAdapterInstall", () => {
  it("reports not-installed when there is no node_modules/.package-lock.json at all", async () => {
    const result = await verifyAdapterInstall("claude-code", homeDir);
    expect(result).toEqual({ ok: false, reason: "not-installed" });
  });

  it("reports not-installed when the lockfile exists but has no entry for this package", async () => {
    await mkdir(path.dirname(installedLockPath(homeDir)), { recursive: true });
    await writeFile(installedLockPath(homeDir), JSON.stringify({ packages: {} }), "utf8");

    const result = await verifyAdapterInstall("claude-code", homeDir);
    expect(result).toEqual({ ok: false, reason: "not-installed" });
  });

  it("reports not-installed when the lockfile is corrupt JSON", async () => {
    await mkdir(path.dirname(installedLockPath(homeDir)), { recursive: true });
    await writeFile(installedLockPath(homeDir), "{not json", "utf8");

    const result = await verifyAdapterInstall("claude-code", homeDir);
    expect(result).toEqual({ ok: false, reason: "not-installed" });
  });

  it("reports version-mismatch when the installed version differs from the pinned manifest", async () => {
    await writeLock({ version: "0.0.1" });
    await writeEntryFile();

    const result = await verifyAdapterInstall("claude-code", homeDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("version-mismatch");
      expect(result.detail).toContain("0.0.1");
    }
  });

  it("reports integrity-mismatch when the installed integrity differs from the pinned manifest", async () => {
    await writeLock({ integrity: "sha512-tampered==" });
    await writeEntryFile();

    const result = await verifyAdapterInstall("claude-code", homeDir);
    expect(result).toEqual({
      ok: false,
      reason: "integrity-mismatch",
      detail: "installed package integrity does not match the pinned manifest",
    });
  });

  it("reports entry-missing when the lockfile matches but the spawn entrypoint isn't on disk", async () => {
    await writeLock();
    // No writeEntryFile() call.

    const result = await verifyAdapterInstall("claude-code", homeDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("entry-missing");
  });

  it("reports ok with the resolved entry path when version, integrity, and entrypoint all match", async () => {
    await writeLock();
    await writeEntryFile();

    const result = await verifyAdapterInstall("claude-code", homeDir);
    expect(result).toEqual({
      ok: true,
      entryPath: adapterEntryPath("claude-code", homeDir),
      version: ADAPTER_MANIFEST["claude-code"].version,
    });
  });

  it("keeps the two adapters' verification independent", async () => {
    await writeLock();
    await writeEntryFile();

    const claude = await verifyAdapterInstall("claude-code", homeDir);
    const codex = await verifyAdapterInstall("codex", homeDir);

    expect(claude.ok).toBe(true);
    expect(codex).toEqual({ ok: false, reason: "not-installed" });
    expect(adapterPackageDir("codex", homeDir)).not.toBe(adapterPackageDir("claude-code", homeDir));
  });
});
