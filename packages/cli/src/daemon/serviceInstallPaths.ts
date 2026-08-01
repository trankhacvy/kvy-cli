/**
 * Path/label resolution for `kvy daemon service install/uninstall/status`
 * (kvy-prd.md FR-4.1 "installable as a login service (launchd /
 * systemd-user) [P1]"; kvy-system-design.md §8 "Service install (P1):
 * launchd plist / systemd-user unit / schtasks, all labeled
 * `dev.kvy.daemon`"; plan.md §16 "4.3 Distribution & self-host").
 *
 * macOS uses launchd (`~/Library/LaunchAgents`); Linux uses a systemd
 * `--user` unit (`~/.config/systemd/user`). Windows (`schtasks`) is out of
 * scope — kvy-prd.md FR-1.1 marks Windows support `[P2]`, unimplemented
 * anywhere else in the CLI yet either (`processScan.ts`, `gitExec.ts`).
 */
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveHomeDir } from "../home.js";

/** Every platform's service is registered under this one label (design §8). */
export const SERVICE_LABEL = "dev.kvy.daemon";

export type ServicePlatform = "launchd" | "systemd";

export interface ServiceInstallOptions {
  /** Overrides `~/.kvy` (or `KVY_HOME_DIR`) — where service logs live. */
  homeDir?: string;
  /** Overrides `os.homedir()` — where the plist/unit file itself is written. Test seam only. */
  userHomeDir?: string;
  /** Overrides `process.platform`. Test seam only. */
  platform?: NodeJS.Platform;
  /** Overrides the resolved absolute path to the `kvy` executable the service execs. */
  kvyExecutable?: string;
  env?: NodeJS.ProcessEnv;
}

export class UnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(
      `kvy daemon service install/uninstall/status is not supported on "${platform}". ` +
        "Only macOS (launchd) and Linux (systemd --user) are supported today. " +
        "Windows support is a documented fast-follow (kvy-prd.md FR-1.1).",
    );
    this.name = "UnsupportedPlatformError";
  }
}

export function resolveServicePlatform(options: ServiceInstallOptions = {}): ServicePlatform {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  throw new UnsupportedPlatformError(platform);
}

function resolveUserHomeDir(options: ServiceInstallOptions): string {
  return options.userHomeDir ?? homedir();
}

export function launchAgentPlistPath(options: ServiceInstallOptions = {}): string {
  return path.join(
    resolveUserHomeDir(options),
    "Library",
    "LaunchAgents",
    `${SERVICE_LABEL}.plist`,
  );
}

export function systemdUnitPath(options: ServiceInstallOptions = {}): string {
  return path.join(
    resolveUserHomeDir(options),
    ".config",
    "systemd",
    "user",
    `${SERVICE_LABEL}.service`,
  );
}

/** The plist/unit file path for whichever platform `options` resolves to. */
export function servicePath(options: ServiceInstallOptions = {}): string {
  const platform = resolveServicePlatform(options);
  return platform === "launchd" ? launchAgentPlistPath(options) : systemdUnitPath(options);
}

export function daemonServiceLogPaths(options: ServiceInstallOptions = {}): {
  stdout: string;
  stderr: string;
} {
  const homeDir = options.homeDir ?? resolveHomeDir(options.env ?? process.env);
  return {
    stdout: path.join(homeDir, "logs", "daemon.service.log"),
    stderr: path.join(homeDir, "logs", "daemon.service.error.log"),
  };
}

/**
 * Scans `PATH` for an executable named `kvy`, the same resolution a
 * shell would do — this is what makes the installed service keep working
 * across `npm i -g kvy` upgrades, the `curl | sh` standalone binary, and
 * nvm-managed Node installs alike, without hardcoding any of their
 * installation layouts. Returns `null` (never throws) when nothing is
 * found; `resolveKvyExecutable` below turns that into an actionable
 * error rather than silently installing a service that execs nothing.
 */
export function findKvyOnPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    const candidate = path.join(dir, "kvy");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

/**
 * Resolves the absolute `kvy` executable path the generated service will
 * exec. Honors `options.kvyExecutable` as an explicit override (test
 * seam / manual escape hatch); otherwise resolves it off `PATH`. Throws
 * rather than falling back to a guess — a launchd plist or systemd unit
 * pointing at a nonexistent binary fails silently in the background with no
 * obvious signal to the user, exactly the "no silent failures" case this
 * needs to avoid.
 */
export function resolveKvyExecutable(options: ServiceInstallOptions = {}): string {
  if (options.kvyExecutable) return options.kvyExecutable;
  const found = findKvyOnPath(options.env ?? process.env);
  if (found) return found;
  throw new Error(
    "Could not locate the `kvy` executable on PATH. Install it first " +
      "(`npm i -g kvy`, or the `curl | sh` standalone installer) and make sure " +
      "it's on PATH, then re-run `kvy daemon service install`.",
  );
}
