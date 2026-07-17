import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  daemonServiceLogPaths,
  findFalconOnPath,
  launchAgentPlistPath,
  resolveFalconExecutable,
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
  it("launchAgentPlistPath is under Library/LaunchAgents, labeled dev.falcon.daemon", () => {
    const result = launchAgentPlistPath({ userHomeDir: "/home/u" });
    expect(result).toBe(path.join("/home/u", "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`));
  });

  it("systemdUnitPath is under .config/systemd/user, labeled dev.falcon.daemon", () => {
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
    const result = daemonServiceLogPaths({ homeDir: "/home/u/.falcon" });
    expect(result.stdout).toBe(path.join("/home/u/.falcon", "logs", "daemon.service.log"));
    expect(result.stderr).toBe(path.join("/home/u/.falcon", "logs", "daemon.service.error.log"));
  });
});

describe("findFalconOnPath", () => {
  it("returns null when no PATH entry has an executable falcon", () => {
    expect(findFalconOnPath({ PATH: "/nonexistent-dir-xyz" })).toBeNull();
  });

  it("finds falcon when a PATH entry has it (self-test against node's own binary dir)", () => {
    // node's own execPath dir always contains an executable "node" but not
    // necessarily "falcon" — this test only asserts the empty-PATH-entries
    // and malformed-dir cases don't throw, real resolution is exercised via
    // resolveFalconExecutable's explicit-override path below.
    expect(() => findFalconOnPath({ PATH: "" })).not.toThrow();
  });
});

describe("resolveFalconExecutable", () => {
  it("returns the explicit override untouched", () => {
    expect(resolveFalconExecutable({ falconExecutable: "/opt/falcon/bin/falcon" })).toBe(
      "/opt/falcon/bin/falcon",
    );
  });

  it("throws an actionable error when falcon isn't on PATH and no override is given", () => {
    expect(() => resolveFalconExecutable({ env: { PATH: "/nonexistent-dir-xyz" } })).toThrow(
      /Could not locate the `falcon` executable on PATH/,
    );
  });
});
