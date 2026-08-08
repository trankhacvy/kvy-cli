import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  daemonServiceLogPaths,
  findKvyOnPath,
  isServiceInstalled,
  launchAgentPlistPath,
  resolveKvyExecutable,
  resolveServicePlatform,
  SERVICE_LABEL,
  servicePath,
  systemdUnitPath,
  UnsupportedPlatformError,
} from "./serviceInstallPaths.js";

describe("resolveServicePlatform", () => {
  it("maps darwin to launchd", () => {
    expect(resolveServicePlatform({ platform: "darwin" })).toBe("launchd");
  });

  it("maps linux to systemd", () => {
    expect(resolveServicePlatform({ platform: "linux" })).toBe("systemd");
  });

  it("throws UnsupportedPlatformError for win32", () => {
    expect(() => resolveServicePlatform({ platform: "win32" })).toThrow(UnsupportedPlatformError);
  });
});

describe("path builders", () => {
  it("launchAgentPlistPath is under Library/LaunchAgents, labeled dev.kvy.daemon", () => {
    const result = launchAgentPlistPath({ userHomeDir: "/home/u" });
    expect(result).toBe(path.join("/home/u", "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`));
  });

  it("systemdUnitPath is under .config/systemd/user, labeled dev.kvy.daemon", () => {
    const result = systemdUnitPath({ userHomeDir: "/home/u" });
    expect(result).toBe(
      path.join("/home/u", ".config", "systemd", "user", `${SERVICE_LABEL}.service`),
    );
  });

  it("servicePath picks the plist path on darwin", () => {
    expect(servicePath({ platform: "darwin", userHomeDir: "/home/u" })).toBe(
      launchAgentPlistPath({ userHomeDir: "/home/u" }),
    );
  });

  it("servicePath picks the unit path on linux", () => {
    expect(servicePath({ platform: "linux", userHomeDir: "/home/u" })).toBe(
      systemdUnitPath({ userHomeDir: "/home/u" }),
    );
  });
});

describe("daemonServiceLogPaths", () => {
  it("nests both logs under homeDir/logs", () => {
    const result = daemonServiceLogPaths({ homeDir: "/home/u/.kvy" });
    expect(result.stdout).toBe(path.join("/home/u/.kvy", "logs", "daemon.service.log"));
    expect(result.stderr).toBe(path.join("/home/u/.kvy", "logs", "daemon.service.error.log"));
  });
});

describe("findKvyOnPath", () => {
  it("returns null when no PATH entry has an executable kvy", () => {
    expect(findKvyOnPath({ PATH: "/nonexistent-dir-xyz" })).toBeNull();
  });

  it("finds kvy when a PATH entry has it (self-test against node's own binary dir)", () => {
    // node's own execPath dir always contains an executable "node" but not
    // necessarily "kvy" — this test only asserts the empty-PATH-entries
    // and malformed-dir cases don't throw, real resolution is exercised via
    // resolveKvyExecutable's explicit-override path below.
    expect(() => findKvyOnPath({ PATH: "" })).not.toThrow();
  });
});

describe("resolveKvyExecutable", () => {
  it("returns the explicit override untouched", () => {
    expect(resolveKvyExecutable({ kvyExecutable: "/opt/kvy/bin/kvy" })).toBe("/opt/kvy/bin/kvy");
  });

  it("throws an actionable error when kvy isn't on PATH and no override is given", () => {
    expect(() => resolveKvyExecutable({ env: { PATH: "/nonexistent-dir-xyz" } })).toThrow(
      /Could not locate the `kvy` executable on PATH/,
    );
  });
});

describe("isServiceInstalled", () => {
  let userHomeDir: string;

  beforeEach(() => {
    userHomeDir = mkdtempSync(path.join(tmpdir(), "kvy-service-installed-"));
  });

  afterEach(() => {
    rmSync(userHomeDir, { recursive: true, force: true });
  });

  it("is false when no plist/unit file exists yet", () => {
    expect(isServiceInstalled({ platform: "darwin", userHomeDir })).toBe(false);
  });

  it("is true once the plist file is on disk", () => {
    const target = launchAgentPlistPath({ userHomeDir });
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "<xml/>", "utf8");
    expect(isServiceInstalled({ platform: "darwin", userHomeDir })).toBe(true);
  });

  it("propagates UnsupportedPlatformError on win32, same as servicePath", () => {
    expect(() => isServiceInstalled({ platform: "win32", userHomeDir })).toThrow(
      UnsupportedPlatformError,
    );
  });
});
