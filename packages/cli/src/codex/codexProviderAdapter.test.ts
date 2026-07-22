import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_NOT_INSTALLED_MESSAGE,
  codexProvider,
  detectCodex,
  startLocal,
} from "./codexProviderAdapter.js";

describe("detectCodex", () => {
  it("reports installed+authenticated when the version check succeeds", async () => {
    const result = await detectCodex({ resolveVersion: () => "codex-cli 0.107.0" });
    expect(result).toEqual({ installed: true, authenticated: true, version: "codex-cli 0.107.0" });
  });

  it("reports not installed with an actionable error when the version check fails", async () => {
    const result = await detectCodex({ resolveVersion: () => null });
    expect(result).toEqual({
      installed: false,
      authenticated: false,
      error: CODEX_NOT_INSTALLED_MESSAGE,
    });
  });

  // Regression coverage for daemon-boot-codex-shim-recursion: with no
  // `resolveVersion` override, `detectCodex` shells out for real — this
  // exercises `findCodexInPath`'s shim-skip guard directly, the same way
  // `claudeCliLocator.test.ts`'s "skips Falcon's own shim on PATH" case
  // covers the equivalent Claude guard.
  describe("default version resolution (real PATH lookup)", () => {
    let root: string;
    const originalPath = process.env.PATH;

    beforeEach(() => {
      root = mkdtempSync(path.join(tmpdir(), "falcon-codex-adapter-path-"));
    });

    afterEach(() => {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    });

    it("skips Falcon's own codex PATH shim instead of recursing into it", async () => {
      if (process.platform === "win32") return;

      // Mirrors `falcon shim install`'s layout exactly: `<FALCON_HOME_DIR>/bin/codex`.
      const falconHomeDir = path.join(root, "falcon-home");
      const shimDir = path.join(falconHomeDir, "bin");
      mkdirSync(shimDir, { recursive: true });
      const shimPath = path.join(shimDir, "codex");
      writeFileSync(shimPath, '#!/usr/bin/env sh\nexec falcon codex "$@"\n');
      chmodSync(shimPath, 0o755);

      // Shim dir wins the PATH race, same as after `falcon shim install`
      // prepends it — no real codex install anywhere else on PATH here, so
      // a buggy resolver would shell back out into the shim (and, if the
      // shim's `exec falcon codex "$@"` actually ran, recurse forever).
      process.env.PATH = `${shimDir}:${originalPath ?? ""}`;

      const result = await detectCodex({ env: { FALCON_HOME_DIR: falconHomeDir } });
      expect(result).toEqual({
        installed: false,
        authenticated: false,
        error: CODEX_NOT_INSTALLED_MESSAGE,
      });
    });
  });
});

describe("codexProvider.startLocal", () => {
  it("always returns null — Codex has no local TUI mode", () => {
    expect(startLocal({})).toBeNull();
    expect(codexProvider.startLocal({})).toBeNull();
  });

  it("exposes the 'codex' provider id", () => {
    expect(codexProvider.id).toBe("codex");
  });
});
