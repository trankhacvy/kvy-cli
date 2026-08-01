import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdate } from "./applyUpdate.js";

function fakeFetch(handlers: Record<string, () => Response>) {
  return vi.fn((url: string) => {
    const handler = handlers[url];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return Promise.resolve(handler());
  }) as unknown as typeof fetch;
}

const BASE = "https://github.com/kvy-dev/kvy/releases/download/cli-latest";

describe("applyUpdate", () => {
  let dir: string;
  let execPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kvy-apply-update-"));
    execPath = path.join(dir, "kvy");
    await writeFile(execPath, "old binary contents");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("standalone-binary: downloads, verifies, and atomically replaces execPath", async () => {
    const payload = Buffer.from("new binary contents");
    const digest = createHash("sha256").update(payload).digest("hex");
    const fetchImpl = fakeFetch({
      [`${BASE}/kvy-darwin-arm64`]: () => new Response(payload),
      [`${BASE}/kvy-darwin-arm64.sha256`]: () => new Response(`${digest}  kvy-darwin-arm64\n`),
    });

    const result = await applyUpdate({
      installKind: "standalone-binary",
      repo: "kvy-dev/kvy",
      version: "0.2.0",
      execPath,
      fetchImpl,
      platform: "darwin",
      arch: "arm64",
    });

    expect(result).toEqual({ applied: true, installKind: "standalone-binary" });
    expect((await readFile(execPath)).equals(payload)).toBe(true);
    const stats = await stat(execPath);
    const executableBits = stats.mode % 0o1000;
    expect(executableBits).toBe(0o755);
  });

  it("standalone-binary: reports unsupported platform without throwing", async () => {
    const result = await applyUpdate({
      installKind: "standalone-binary",
      repo: "kvy-dev/kvy",
      version: "0.2.0",
      execPath,
      platform: "win32",
      arch: "x64",
    });
    expect(result.applied).toBe(false);
    expect(await readFile(execPath, "utf8")).toBe("old binary contents");
  });

  it("npm: delegates to the injected npm-install runner with the pinned version", async () => {
    const runNpmInstall = vi.fn(async () => {});
    const result = await applyUpdate({
      installKind: "npm",
      repo: "kvy-dev/kvy",
      version: "0.2.0",
      execPath,
      runNpmInstall,
    });
    expect(result).toEqual({ applied: true, installKind: "npm" });
    expect(runNpmInstall).toHaveBeenCalledWith("kvy-cli@0.2.0");
  });

  it("dev: no-op, never touches the filesystem", async () => {
    const result = await applyUpdate({
      installKind: "dev",
      repo: "kvy-dev/kvy",
      version: "0.2.0",
      execPath,
    });
    expect(result.applied).toBe(false);
    expect(await readFile(execPath, "utf8")).toBe("old binary contents");
  });
});
