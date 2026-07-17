import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServiceCommandDeps } from "../daemon/serviceInstall.js";
import { runDaemonServiceCommand } from "./serviceInstall.js";

let homeDir: string;
let userHomeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "falcon-service-cmd-home-"));
  userHomeDir = mkdtempSync(path.join(tmpdir(), "falcon-service-cmd-user-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(userHomeDir, { recursive: true, force: true });
});

function collectWrites() {
  const lines: string[] = [];
  return { write: (text: string) => lines.push(text), lines };
}

const okExec: ServiceCommandDeps = { exec: async () => ({ ok: true, output: "" }) };

describe("runDaemonServiceCommand", () => {
  it("install: writes the plist/unit and returns exit code 0 on success", async () => {
    const { write, lines } = collectWrites();

    const code = await runDaemonServiceCommand("install", {
      serviceOptions: {
        homeDir,
        userHomeDir,
        platform: "linux",
        falconExecutable: "/usr/local/bin/falcon",
      },
      serviceDeps: okExec,
      write,
    });

    expect(code).toBe(0);
    expect(lines.join("")).toContain("Installed systemd --user service");
  });

  it("install: returns exit code 1 and surfaces the error when the service manager call fails", async () => {
    const { write, lines } = collectWrites();

    const code = await runDaemonServiceCommand("install", {
      serviceOptions: {
        homeDir,
        userHomeDir,
        platform: "linux",
        falconExecutable: "/usr/local/bin/falcon",
      },
      serviceDeps: { exec: async () => ({ ok: false, output: "permission denied" }) },
      write,
    });

    expect(code).toBe(1);
    expect(lines.join("")).toContain("permission denied");
  });

  it("uninstall: reports nothing-to-do when never installed", async () => {
    const { write, lines } = collectWrites();

    const code = await runDaemonServiceCommand("uninstall", {
      serviceOptions: {
        homeDir,
        userHomeDir,
        platform: "linux",
        falconExecutable: "/usr/local/bin/falcon",
      },
      serviceDeps: okExec,
      write,
    });

    expect(code).toBe(0);
    expect(lines.join("")).toContain("No systemd --user service was installed");
  });

  it("status: reports missing before install runs", async () => {
    const { write, lines } = collectWrites();

    const code = await runDaemonServiceCommand("status", {
      serviceOptions: {
        homeDir,
        userHomeDir,
        platform: "linux",
        falconExecutable: "/usr/local/bin/falcon",
      },
      serviceDeps: okExec,
      write,
    });

    expect(code).toBe(0);
    expect(lines.join("")).toContain("missing");
  });
});
