import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { runUpdateCommand } from "./runUpdateCommand.js";

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const BASE_DEPS = {
  currentVersion: "0.1.0",
  isCompiledBinary: true,
  bundlePath: "/nonexistent/dist/index.mjs",
  execPath: "/nonexistent/falcon",
  env: {},
  logger: fakeLogger(),
};

describe("runUpdateCommand", () => {
  it("dev mode: skips without hitting the network", async () => {
    const fetchLatestVersionImpl = vi.fn();
    const result = await runUpdateCommand({
      ...BASE_DEPS,
      isCompiledBinary: false,
      fetchLatestVersionImpl,
    });
    expect(result.code).toBe(0);
    expect(fetchLatestVersionImpl).not.toHaveBeenCalled();
  });

  it("reports up to date when the latest version isn't newer", async () => {
    const fetchLatestVersionImpl = vi.fn(async () => "0.1.0");
    const result = await runUpdateCommand({ ...BASE_DEPS, fetchLatestVersionImpl });
    expect(result.code).toBe(0);
    expect(result.message).toContain("already up to date");
  });

  it("applies an update when a newer version is found", async () => {
    const fetchLatestVersionImpl = vi.fn(async () => "0.2.0");
    const applyUpdateImpl = vi.fn(async () => ({ applied: true as const, installKind: "standalone-binary" as const }));
    const result = await runUpdateCommand({
      ...BASE_DEPS,
      fetchLatestVersionImpl,
      applyUpdateImpl,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("updated 0.1.0 -> 0.2.0");
    expect(applyUpdateImpl).toHaveBeenCalledWith(
      expect.objectContaining({ installKind: "standalone-binary", version: "0.2.0" }),
    );
  });

  it("fails safe (non-throwing) when the version check can't be reached", async () => {
    const fetchLatestVersionImpl = vi.fn(async () => null);
    const result = await runUpdateCommand({ ...BASE_DEPS, fetchLatestVersionImpl });
    expect(result.code).toBe(1);
    expect(result.message).toContain("could not check for updates");
  });

  it("silent mode still returns code 0 on a failed check (never fatal for the background path)", async () => {
    const fetchLatestVersionImpl = vi.fn(async () => null);
    const result = await runUpdateCommand({
      ...BASE_DEPS,
      env: { FALCON_UPDATE_SILENT: "1" },
      fetchLatestVersionImpl,
    });
    expect(result.code).toBe(0);
    expect(result.message).toBe("");
  });

  it("reports a clear failure message when apply throws, without throwing itself", async () => {
    const fetchLatestVersionImpl = vi.fn(async () => "0.2.0");
    const applyUpdateImpl = vi.fn(async () => {
      throw new Error("checksum mismatch");
    });
    const result = await runUpdateCommand({
      ...BASE_DEPS,
      fetchLatestVersionImpl,
      applyUpdateImpl,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("update failed — checksum mismatch");
  });
});
