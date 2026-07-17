import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installShim } from "./install.js";
import { shimBinDir } from "./paths.js";
import { shimStatus } from "./status.js";

let homeDir: string;
let userHomeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-shim-status-home-"));
  userHomeDir = mkdtempSync(path.join(tmpdir(), "falcon-shim-status-user-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(userHomeDir, { recursive: true, force: true });
});

describe("shimStatus", () => {
  it("reports nothing installed before install runs", async () => {
    const status = await shimStatus({ homeDir, userHomeDir, env: { PATH: "/usr/bin" } });

    expect(status.installedBinaries).toEqual([]);
    expect(status.missingBinaries).toHaveLength(2);
    expect(status.rcFilesWithBlock).toEqual([]);
    expect(status.binDirOnPath).toBe(false);
  });

  it("reports both binaries and the rc file after install", async () => {
    await installShim({ homeDir, userHomeDir, env: {} });

    const status = await shimStatus({ homeDir, userHomeDir, env: { PATH: "/usr/bin" } });

    expect(status.installedBinaries).toHaveLength(2);
    expect(status.missingBinaries).toEqual([]);
    expect(status.rcFilesWithBlock).toEqual([path.join(userHomeDir, ".profile")]);
  });

  it("reports binDirOnPath true when the bin dir is already on $PATH", async () => {
    const binDir = shimBinDir({ homeDir });
    const status = await shimStatus({
      homeDir,
      userHomeDir,
      env: { PATH: `/usr/bin${path.delimiter}${binDir}` },
    });

    expect(status.binDirOnPath).toBe(true);
  });
});
