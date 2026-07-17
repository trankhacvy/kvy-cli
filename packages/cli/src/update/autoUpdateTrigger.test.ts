import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { readSettings } from "../persistence.js";
import { maybeTriggerAutoUpdate } from "./autoUpdateTrigger.js";

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("maybeTriggerAutoUpdate", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-auto-update-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("skips and never spawns when FALCON_NO_UPDATE is set", async () => {
    const spawnBackgroundUpdate = vi.fn();
    await maybeTriggerAutoUpdate({
      isCompiledBinary: true,
      bundlePath: "/nonexistent",
      env: { FALCON_NO_UPDATE: "1" },
      homeDir,
      logger: fakeLogger(),
      spawnBackgroundUpdate,
    });
    expect(spawnBackgroundUpdate).not.toHaveBeenCalled();
  });

  it("skips and never spawns in dev mode", async () => {
    const spawnBackgroundUpdate = vi.fn();
    await maybeTriggerAutoUpdate({
      isCompiledBinary: false,
      bundlePath: path.join(homeDir, "does-not-exist.mjs"),
      env: {},
      homeDir,
      logger: fakeLogger(),
      spawnBackgroundUpdate,
    });
    expect(spawnBackgroundUpdate).not.toHaveBeenCalled();
  });

  it("spawns the background child and records the check timestamp on first run", async () => {
    const spawnBackgroundUpdate = vi.fn();
    const now = () => 1_000_000;
    await maybeTriggerAutoUpdate({
      isCompiledBinary: true,
      bundlePath: "/nonexistent",
      env: {},
      homeDir,
      logger: fakeLogger(),
      spawnBackgroundUpdate,
      now,
      intervalMs: 60_000,
    });
    expect(spawnBackgroundUpdate).toHaveBeenCalledTimes(1);
    const settings = await readSettings({ homeDir });
    expect(settings.lastUpdateCheckAt).toBe(1_000_000);
  });

  it("does not spawn again within the rate-limit interval", async () => {
    const spawnBackgroundUpdate = vi.fn();
    let now = 1_000_000;
    const deps = {
      isCompiledBinary: true,
      bundlePath: "/nonexistent",
      env: {},
      homeDir,
      logger: fakeLogger(),
      spawnBackgroundUpdate,
      now: () => now,
      intervalMs: 60_000,
    };

    await maybeTriggerAutoUpdate(deps);
    now += 10_000; // still within the 60s interval
    await maybeTriggerAutoUpdate(deps);

    expect(spawnBackgroundUpdate).toHaveBeenCalledTimes(1);
  });

  it("spawns again once the rate-limit interval has elapsed", async () => {
    const spawnBackgroundUpdate = vi.fn();
    let now = 1_000_000;
    const deps = {
      isCompiledBinary: true,
      bundlePath: "/nonexistent",
      env: {},
      homeDir,
      logger: fakeLogger(),
      spawnBackgroundUpdate,
      now: () => now,
      intervalMs: 60_000,
    };

    await maybeTriggerAutoUpdate(deps);
    now += 61_000;
    await maybeTriggerAutoUpdate(deps);

    expect(spawnBackgroundUpdate).toHaveBeenCalledTimes(2);
  });

  it("never throws even if the spawn implementation does", async () => {
    const spawnBackgroundUpdate = vi.fn(() => {
      throw new Error("spawn EAGAIN");
    });
    await expect(
      maybeTriggerAutoUpdate({
        isCompiledBinary: true,
        bundlePath: "/nonexistent",
        env: {},
        homeDir,
        logger: fakeLogger(),
        spawnBackgroundUpdate,
      }),
    ).resolves.toBeUndefined();
  });
});
