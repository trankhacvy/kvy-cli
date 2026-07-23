import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCredentials } from "./credentials.js";
import { runAuthLogout } from "./logout.js";

let homeDir: string;

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-logout-test-"));
  process.env.FALCON_HOME_DIR = homeDir;
});

afterEach(() => {
  delete process.env.FALCON_HOME_DIR;
  rmSync(homeDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runAuthLogout", () => {
  it("reports not logged in and exits 0 when there are no stored credentials", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = fakeLogger();

    const code = runAuthLogout(logger);

    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith("Not logged in.\n");
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("clears stored credentials, logs, and exits 0 when logged in", () => {
    writeCredentials({ refreshToken: "t", masterSecretOrContentBundle: "s" }, homeDir);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = fakeLogger();

    const code = runAuthLogout(logger);

    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith("Logged out.\n");
    expect(logger.info).toHaveBeenCalledWith("auth logout: credentials cleared");
  });

  it("is idempotent — running logout twice never throws", () => {
    writeCredentials({ refreshToken: "t", masterSecretOrContentBundle: "s" }, homeDir);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = fakeLogger();

    expect(runAuthLogout(logger)).toBe(0);
    expect(runAuthLogout(logger)).toBe(0);
  });
});
