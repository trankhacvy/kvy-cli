import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterIntegrityError, installAdapter, installAllAdapters } from "./install.js";
import { ADAPTER_MANIFEST } from "./manifest.js";
import { adapterEntryPath, adaptersPackageJsonPath } from "./paths.js";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), "falcon-adapters-install-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

/** A fake `npm install` that writes exactly what a real `npm ci`/`install` would leave behind for the requested `pkg@version`, so `verifyAdapterInstall` sees a satisfied install afterward — without ever touching the network. */
function fakeNpmInstall(overrides: Partial<{ version: string; integrity: string }> = {}) {
  return vi.fn(async (args: string[], cwd: string) => {
    const spec = args[1] as string; // "install", "<pkg>@<version>", ...
    const at = spec.lastIndexOf("@");
    const pkgName = spec.slice(0, at);
    const version = overrides.version ?? spec.slice(at + 1);
    const integrity =
      overrides.integrity ??
      Object.values(ADAPTER_MANIFEST).find((e) => e.packageName === pkgName)?.integrity;

    const lockPath = path.join(cwd, "node_modules", ".package-lock.json");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ packages: { [`node_modules/${pkgName}`]: { version, integrity } } }),
      "utf8",
    );

    const entry = Object.values(ADAPTER_MANIFEST).find((e) => e.packageName === pkgName);
    if (entry) {
      const entryFile = path.join(cwd, "node_modules", ...pkgName.split("/"), entry.binEntry);
      await mkdir(path.dirname(entryFile), { recursive: true });
      await writeFile(entryFile, "// fake\n", "utf8");
    }
  });
}

describe("installAdapter", () => {
  it("writes a root package.json under the adapters dir on first install", async () => {
    const runNpm = fakeNpmInstall();
    await installAdapter("claude-code", { homeDir, runNpm });

    expect(existsSync(adaptersPackageJsonPath(homeDir))).toBe(true);
    const pkg = JSON.parse(await readFile(adaptersPackageJsonPath(homeDir), "utf8"));
    expect(pkg.private).toBe(true);
  });

  it("runs npm install with the exact pinned package@version and reports installed", async () => {
    const runNpm = fakeNpmInstall();
    const outcome = await installAdapter("claude-code", { homeDir, runNpm });

    const entry = ADAPTER_MANIFEST["claude-code"];
    expect(runNpm).toHaveBeenCalledWith(
      expect.arrayContaining(["install", `${entry.packageName}@${entry.version}`, "--save-exact"]),
      expect.stringContaining("adapters"),
    );
    expect(outcome).toEqual({
      id: "claude-code",
      ok: true,
      status: "installed",
      version: entry.version,
      path: adapterEntryPath("claude-code", homeDir),
    });
  });

  it("skips npm entirely when the pinned version+integrity is already installed", async () => {
    const runNpm = fakeNpmInstall();
    await installAdapter("claude-code", { homeDir, runNpm });
    runNpm.mockClear();

    const outcome = await installAdapter("claude-code", { homeDir, runNpm });

    expect(runNpm).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: true, status: "already-satisfied" });
  });

  it("re-runs npm and reports reinstalled when force: true, even if already satisfied", async () => {
    const runNpm = fakeNpmInstall();
    await installAdapter("claude-code", { homeDir, runNpm });
    runNpm.mockClear();

    const outcome = await installAdapter("claude-code", { homeDir, runNpm }, { force: true });

    expect(runNpm).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: true, status: "reinstalled" });
  });

  it("returns an ok:false outcome (never throws) when npm itself fails", async () => {
    const runNpm = vi.fn(async () => {
      throw new Error("registry unreachable");
    });

    const outcome = await installAdapter("claude-code", { homeDir, runNpm });
    expect(outcome).toEqual({ id: "claude-code", ok: false, error: "registry unreachable" });
  });

  it("returns an ok:false outcome when npm reports success but the result fails integrity verification", async () => {
    const runNpm = fakeNpmInstall({ integrity: "sha512-wrong==" });

    const outcome = await installAdapter("claude-code", { homeDir, runNpm });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("integrity");
    }
  });

  it("AdapterIntegrityError is exported for callers that want to distinguish the failure class", () => {
    expect(new AdapterIntegrityError("x")).toBeInstanceOf(Error);
  });
});

describe("installAllAdapters", () => {
  it("installs every adapter in the manifest, isolating one adapter's failure from the rest", async () => {
    const runNpm = vi.fn(async (args: string[], cwd: string) => {
      const spec = args[1] as string;
      if (spec.startsWith("@agentclientprotocol/codex-acp")) {
        throw new Error("codex registry down");
      }
      return fakeNpmInstall()(args, cwd);
    });

    const outcomes = await installAllAdapters({ homeDir, runNpm });

    expect(outcomes).toHaveLength(2);
    const claude = outcomes.find((o) => o.id === "claude-code");
    const codex = outcomes.find((o) => o.id === "codex");
    expect(claude?.ok).toBe(true);
    expect(codex).toEqual({ id: "codex", ok: false, error: "codex registry down" });
  });
});
