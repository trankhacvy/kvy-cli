import { describe, expect, it } from "vitest";
import { SERVICE_LABEL } from "./serviceInstallPaths.js";
import { buildLaunchdPlist, buildSystemdUnit } from "./serviceInstallTemplates.js";

const baseConfig = {
  falconExecutable: "/usr/local/bin/falcon",
  stdoutLogPath: "/home/u/.falcon/logs/daemon.service.log",
  stderrLogPath: "/home/u/.falcon/logs/daemon.service.error.log",
};

describe("buildLaunchdPlist", () => {
  it("is valid-shaped plist XML with the falcon daemon start-sync argv", () => {
    const plist = buildLaunchdPlist(baseConfig);

    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain("<string>/usr/local/bin/falcon</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>start-sync</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain(baseConfig.stdoutLogPath);
    expect(plist).toContain(baseConfig.stderrLogPath);
    expect(plist).not.toContain("EnvironmentVariables");
  });

  it("includes an EnvironmentVariables dict when env overrides are given", () => {
    const plist = buildLaunchdPlist({
      ...baseConfig,
      env: { FALCON_HOME_DIR: "/home/u/.falcon2" },
    });

    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>FALCON_HOME_DIR</key>");
    expect(plist).toContain("<string>/home/u/.falcon2</string>");
  });

  it("XML-escapes special characters in the executable path", () => {
    const plist = buildLaunchdPlist({ ...baseConfig, falconExecutable: "/usr/local/bin/a & b" });
    expect(plist).toContain("/usr/local/bin/a &amp; b");
    expect(plist).not.toContain("/usr/local/bin/a & b</string>");
  });
});

describe("buildSystemdUnit", () => {
  it("is a valid-shaped unit file with the falcon daemon start-sync ExecStart", () => {
    const unit = buildSystemdUnit(baseConfig);

    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain(`ExecStart=${baseConfig.falconExecutable} daemon start-sync`);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain(`StandardOutput=append:${baseConfig.stdoutLogPath}`);
    expect(unit).toContain(`StandardError=append:${baseConfig.stderrLogPath}`);
    expect(unit).toContain("WantedBy=default.target");
  });

  it("adds an Environment= line per env override", () => {
    const unit = buildSystemdUnit({ ...baseConfig, env: { FALCON_HOME_DIR: "/home/u/.falcon2" } });
    expect(unit).toContain("Environment=FALCON_HOME_DIR=/home/u/.falcon2");
  });
});
