/**
 * `kvy daemon service install/uninstall/status` — registers the daemon
 * as a login-managed OS service so it auto-starts and is supervised
 * (kvy-prd.md FR-4.1 "installable as a login service (launchd /
 * systemd-user) [P1]"; kvy-system-design.md §8 "Service install (P1)";
 * plan.md §16 "4.3 Distribution & self-host").
 *
 * macOS: writes a launchd plist to `~/Library/LaunchAgents` and registers
 * it via `launchctl bootstrap gui/<uid>` (the modern replacement for the
 * deprecated `launchctl load`). Linux: writes a systemd `--user` unit to
 * `~/.config/systemd/user` and registers it via `systemctl --user enable
 * --now`. Both point straight at `kvy daemon start-sync`
 * (`serviceInstallTemplates.ts`) — see that module's doc comment for why.
 *
 * Every `launchctl`/`systemctl` invocation is injectable (`ServiceExec`),
 * same hand-wrapped-`execFile` shape as `gitExec.ts`'s `runGit`/
 * `processScan.ts`'s `runPs` — mockable in tests without a real service
 * manager, since neither launchd nor systemd exists in CI.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  daemonServiceLogPaths,
  resolveKvyExecutable,
  resolveServicePlatform,
  SERVICE_LABEL,
  type ServiceInstallOptions,
  servicePath,
} from "./serviceInstallPaths.js";
import { buildLaunchdPlist, buildSystemdUnit } from "./serviceInstallTemplates.js";

export interface ServiceCommandResult {
  ok: boolean;
  message: string;
}

interface ServiceExecResult {
  ok: boolean;
  /** Combined stdout (falling back to stderr) — captured even on a non-zero exit, since e.g. `systemctl is-active` prints its answer ("inactive") *and* exits non-zero for it. */
  output: string;
}

/** Runs `command args...`, resolving rather than rejecting on a non-zero exit or a missing binary — callers decide what a failure means for their own command. Injectable for tests. */
export type ServiceExec = (command: string, args: string[]) => Promise<ServiceExecResult>;

export const runServiceCommand: ServiceExec = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, (error, stdout, stderr) => {
      const output = (stdout?.toString().trim() || stderr?.toString().trim() || "").trim();
      if (error) {
        resolve({ ok: false, output: output || error.message });
        return;
      }
      resolve({ ok: true, output });
    });
  });

export interface ServiceCommandDeps {
  exec?: ServiceExec;
}

function gid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function launchdDomain(): string {
  return `gui/${gid()}`;
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, target);
}

function resolveEnvOverrides(options: ServiceInstallOptions): Record<string, string> {
  const env = options.env ?? process.env;
  const overrides: Record<string, string> = {};
  if (env.KVY_HOME_DIR) overrides.KVY_HOME_DIR = env.KVY_HOME_DIR;
  return overrides;
}

export async function installService(
  options: ServiceInstallOptions = {},
  deps: ServiceCommandDeps = {},
): Promise<ServiceCommandResult> {
  const exec = deps.exec ?? runServiceCommand;
  const platform = resolveServicePlatform(options);
  const kvyExecutable = resolveKvyExecutable(options);
  const { stdout: stdoutLogPath, stderr: stderrLogPath } = daemonServiceLogPaths(options);
  await mkdir(path.dirname(stdoutLogPath), { recursive: true });

  const config = {
    kvyExecutable,
    stdoutLogPath,
    stderrLogPath,
    env: resolveEnvOverrides(options),
  };
  const target = servicePath(options);

  if (platform === "launchd") {
    await writeFileAtomic(target, buildLaunchdPlist(config));
    const domain = launchdDomain();
    // Idempotent re-install: `bootout` an already-loaded copy first (its
    // failure is expected — and ignored — when nothing was loaded yet),
    // then `bootstrap` fresh so re-running `install` after an edit picks up
    // the new plist rather than leaving the old in-memory registration.
    await exec("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
    const result = await exec("launchctl", ["bootstrap", domain, target]);
    if (!result.ok) {
      return {
        ok: false,
        message: `Wrote ${target}, but \`launchctl bootstrap\` failed: ${result.output}\n`,
      };
    }
    return {
      ok: true,
      message:
        `Installed launchd service ${SERVICE_LABEL} (${target}) and started it.\n` +
        `Logs: ${stdoutLogPath}\n`,
    };
  }

  await writeFileAtomic(target, buildSystemdUnit(config));
  const reload = await exec("systemctl", ["--user", "daemon-reload"]);
  if (!reload.ok) {
    return {
      ok: false,
      message: `Wrote ${target}, but \`systemctl --user daemon-reload\` failed: ${reload.output}\n`,
    };
  }
  const enable = await exec("systemctl", ["--user", "enable", "--now", `${SERVICE_LABEL}.service`]);
  if (!enable.ok) {
    return {
      ok: false,
      message: `Wrote ${target}, but \`systemctl --user enable --now\` failed: ${enable.output}\n`,
    };
  }
  return {
    ok: true,
    message:
      `Installed systemd --user service ${SERVICE_LABEL}.service (${target}) and started it.\n` +
      `Logs: ${stdoutLogPath}\n` +
      "Note: run `loginctl enable-linger $USER` so it also starts before you log in " +
      "(e.g. on a headless server).\n",
  };
}

export async function uninstallService(
  options: ServiceInstallOptions = {},
  deps: ServiceCommandDeps = {},
): Promise<ServiceCommandResult> {
  const exec = deps.exec ?? runServiceCommand;
  const platform = resolveServicePlatform(options);
  const target = servicePath(options);
  const existed = existsSync(target);

  if (platform === "launchd") {
    const domain = launchdDomain();
    const stop = await exec("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
    if (existed) await unlink(target);
    if (!existed) {
      return { ok: true, message: `No launchd service was installed at ${target}.\n` };
    }
    return {
      ok: true,
      message:
        `Stopped and removed launchd service ${SERVICE_LABEL} (${target}).\n` +
        (stop.ok ? "" : `(\`launchctl bootout\` reported: ${stop.output})\n`),
    };
  }

  const disable = await exec("systemctl", [
    "--user",
    "disable",
    "--now",
    `${SERVICE_LABEL}.service`,
  ]);
  if (existed) await unlink(target);
  await exec("systemctl", ["--user", "daemon-reload"]);
  if (!existed) {
    return { ok: true, message: `No systemd --user service was installed at ${target}.\n` };
  }
  return {
    ok: true,
    message:
      `Stopped and removed systemd --user service ${SERVICE_LABEL}.service (${target}).\n` +
      (disable.ok ? "" : `(\`systemctl disable\` reported: ${disable.output})\n`),
  };
}

export async function serviceStatus(
  options: ServiceInstallOptions = {},
  deps: ServiceCommandDeps = {},
): Promise<ServiceCommandResult> {
  const exec = deps.exec ?? runServiceCommand;
  const platform = resolveServicePlatform(options);
  const target = servicePath(options);
  const fileExists = existsSync(target);

  if (platform === "launchd") {
    const domain = launchdDomain();
    const result = await exec("launchctl", ["print", `${domain}/${SERVICE_LABEL}`]);
    return {
      ok: true,
      message:
        `${SERVICE_LABEL}\n` +
        `  plist:   ${target} (${fileExists ? "present" : "missing"})\n` +
        `  running: ${result.ok ? "yes" : "no"}\n`,
    };
  }

  const active = await exec("systemctl", ["--user", "is-active", `${SERVICE_LABEL}.service`]);
  const enabled = await exec("systemctl", ["--user", "is-enabled", `${SERVICE_LABEL}.service`]);
  return {
    ok: true,
    message:
      `${SERVICE_LABEL}.service\n` +
      `  unit:    ${target} (${fileExists ? "present" : "missing"})\n` +
      `  active:  ${active.output || (active.ok ? "active" : "inactive")}\n` +
      `  enabled: ${enabled.output || (enabled.ok ? "enabled" : "disabled")}\n`,
  };
}
