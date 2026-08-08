import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureServiceInstalled,
  installService,
  serviceStatus,
  uninstallService,
} from "./serviceInstall.js";
import type { ServiceInstallOptions } from "./serviceInstallPaths.js";

let homeDir: string;
let userHomeDir: string;
let calls: { command: string; args: string[] }[];

function fakeExec(
  responses: Record<string, { ok: boolean; output?: string }> = {},
  defaultResult: { ok: boolean; output?: string } = { ok: true },
) {
  return async (command: string, args: string[]) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(" ")}`;
    const match = responses[key] ?? defaultResult;
    return { ok: match.ok, output: match.output ?? "" };
  };
}

function options(overrides: Partial<ServiceInstallOptions> = {}): ServiceInstallOptions {
  return {
    homeDir,
    userHomeDir,
    kvyExecutable: "/usr/local/bin/kvy",
    env: {},
    ...overrides,
  };
}

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "kvy-service-home-"));
  userHomeDir = mkdtempSync(path.join(tmpdir(), "kvy-service-user-"));
  calls = [];
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(userHomeDir, { recursive: true, force: true });
});

describe("installService — launchd (darwin)", () => {
  it("writes the plist and bootstraps it via launchctl", async () => {
    const result = await installService(options({ platform: "darwin" }), { exec: fakeExec() });

    expect(result.ok).toBe(true);
    const plistPath = path.join(userHomeDir, "Library", "LaunchAgents", "dev.kvy.daemon.plist");
    expect(existsSync(plistPath)).toBe(true);
    const content = readFileSync(plistPath, "utf8");
    expect(content).toContain("/usr/local/bin/kvy");
    expect(content).toContain("start-sync");

    const commands = calls.map((c) => `${c.command} ${c.args.join(" ")}`);
    expect(commands.some((c) => c.startsWith("launchctl bootout"))).toBe(true);
    expect(commands.some((c) => c.startsWith("launchctl bootstrap"))).toBe(true);
  });

  it("reports failure when launchctl bootstrap fails, but leaves the plist written", async () => {
    const result = await installService(options({ platform: "darwin" }), {
      exec: fakeExec({
        [`launchctl bootstrap gui/${process.getuid?.() ?? 0} ${path.join(userHomeDir, "Library", "LaunchAgents", "dev.kvy.daemon.plist")}`]:
          { ok: false, output: "boom" },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("boom");
  });
});

describe("installService — systemd (linux)", () => {
  it("writes the unit and enables+starts it via systemctl --user", async () => {
    const result = await installService(options({ platform: "linux" }), { exec: fakeExec() });

    expect(result.ok).toBe(true);
    const unitPath = path.join(userHomeDir, ".config", "systemd", "user", "dev.kvy.daemon.service");
    expect(existsSync(unitPath)).toBe(true);
    const content = readFileSync(unitPath, "utf8");
    expect(content).toContain("ExecStart=/usr/local/bin/kvy daemon start-sync");

    const commands = calls.map((c) => `${c.command} ${c.args.join(" ")}`);
    expect(commands).toContain("systemctl --user daemon-reload");
    expect(commands).toContain("systemctl --user enable --now dev.kvy.daemon.service");
  });

  it("includes KVY_HOME_DIR as an Environment= line when set", async () => {
    await installService(options({ platform: "linux", env: { KVY_HOME_DIR: homeDir } }), {
      exec: fakeExec(),
    });

    const unitPath = path.join(userHomeDir, ".config", "systemd", "user", "dev.kvy.daemon.service");
    const content = readFileSync(unitPath, "utf8");
    expect(content).toContain(`Environment=KVY_HOME_DIR=${homeDir}`);
  });
});

describe("uninstallService", () => {
  it("removes an installed launchd plist and reports it was removed", async () => {
    await installService(options({ platform: "darwin" }), { exec: fakeExec() });
    const result = await uninstallService(options({ platform: "darwin" }), { exec: fakeExec() });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Stopped and removed");
    const plistPath = path.join(userHomeDir, "Library", "LaunchAgents", "dev.kvy.daemon.plist");
    expect(existsSync(plistPath)).toBe(false);
  });

  it("is a no-op-but-honest when nothing was installed", async () => {
    const result = await uninstallService(options({ platform: "linux" }), { exec: fakeExec() });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("No systemd --user service was installed");
  });
});

describe("serviceStatus", () => {
  it("reports present+running for an installed, running launchd service", async () => {
    await installService(options({ platform: "darwin" }), { exec: fakeExec() });
    const result = await serviceStatus(options({ platform: "darwin" }), {
      exec: fakeExec({}, { ok: true, output: "state = running" }),
    });

    expect(result.message).toContain("plist:   ");
    expect(result.message).toContain("present");
    expect(result.message).toContain("running: yes");
  });

  it("reports missing+not-running for an uninstalled systemd service", async () => {
    const result = await serviceStatus(options({ platform: "linux" }), {
      exec: fakeExec({}, { ok: false, output: "inactive" }),
    });

    expect(result.message).toContain("missing");
    expect(result.message).toContain("inactive");
  });
});

describe("ensureServiceInstalled", () => {
  it("installs the service and reports 'installed' when nothing was there yet", async () => {
    const result = await ensureServiceInstalled(options({ platform: "darwin" }), {
      exec: fakeExec(),
    });

    expect(result).toEqual({ outcome: "installed", message: expect.any(String) });
    const plistPath = path.join(userHomeDir, "Library", "LaunchAgents", "dev.kvy.daemon.plist");
    expect(existsSync(plistPath)).toBe(true);
  });

  it("reports 'already-installed' and never touches launchctl when the plist already exists", async () => {
    await installService(options({ platform: "darwin" }), { exec: fakeExec() });
    calls = [];

    const result = await ensureServiceInstalled(options({ platform: "darwin" }), {
      exec: fakeExec(),
    });

    expect(result).toEqual({ outcome: "already-installed" });
    expect(calls).toEqual([]);
  });

  it("reports 'unsupported-platform' instead of throwing on win32", async () => {
    const result = await ensureServiceInstalled(options({ platform: "win32" }), {
      exec: fakeExec(),
    });

    expect(result).toEqual({ outcome: "unsupported-platform" });
  });

  it("reports 'failed' (never throws) when the underlying install fails", async () => {
    const result = await ensureServiceInstalled(options({ platform: "darwin" }), {
      exec: fakeExec({}, { ok: false, output: "boom" }),
    });

    expect(result).toEqual({ outcome: "failed", message: expect.stringContaining("boom") });
  });
});
