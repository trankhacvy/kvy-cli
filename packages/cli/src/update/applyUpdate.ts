/**
 * Applies a self-update once `runUpdateCommand.ts` has already decided a
 * newer version is available — the actual "download and atomically replace
 * the running binary/npm install" half of plan.md §16 "4.3 Distribution &
 * self-host".
 */
import { execFile } from "node:child_process";
import { chmod, rename, writeFile } from "node:fs/promises";
import { downloadAndVerify } from "./downloadAndVerify.js";
import type { FetchImpl } from "./fetchLatestVersion.js";
import type { InstallKind } from "./installKind.js";
import { detectPlatformAsset } from "./platformAsset.js";

export type ApplyUpdateResult =
  | { applied: true; installKind: InstallKind }
  | { applied: false; reason: string };

export interface ApplyUpdateOptions {
  installKind: InstallKind;
  repo: string;
  version: string;
  /** Absolute path to the currently-running executable — for `standalone-binary`, this is the file that gets atomically replaced (`process.execPath`, which for a `bun build --compile` binary *is* the executable itself, not a separate node runtime). */
  execPath: string;
  fetchImpl?: FetchImpl;
  /** Injectable `npm install -g` runner — test seam; defaults to a real `execFile("npm", ...)`. */
  runNpmInstall?: (packageSpec: string) => Promise<void>;
  platform?: NodeJS.Platform;
  arch?: string;
}

function defaultRunNpmInstall(packageSpec: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "npm",
      ["install", "-g", packageSpec],
      { timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.toString().trim() || error.message));
          return;
        }
        resolve();
      },
    );
  });
}

/** Downloads the platform binary, verifies it, and atomically replaces `execPath` (write to a sibling tmp file, chmod +x, then `rename` over the target — `rename` is atomic on POSIX, so a concurrently-starting `kvy` process never observes a half-written executable, and the *currently running* process is unaffected since it already holds the old inode open). */
async function applyStandaloneBinaryUpdate(
  options: ApplyUpdateOptions,
): Promise<ApplyUpdateResult> {
  const asset = detectPlatformAsset(options.platform, options.arch);
  if (!asset) {
    return {
      applied: false,
      reason:
        "no standalone binary published for this platform/architecture. Run 'npm install -g kvy-cli' instead",
    };
  }

  const bytes = await downloadAndVerify({
    repo: options.repo,
    assetName: asset.assetName,
    fetchImpl: options.fetchImpl,
  });

  const tmpPath = `${options.execPath}.update-tmp`;
  await writeFile(tmpPath, bytes);
  await chmod(tmpPath, 0o755);
  await rename(tmpPath, options.execPath);

  return { applied: true, installKind: "standalone-binary" };
}

async function applyNpmUpdate(options: ApplyUpdateOptions): Promise<ApplyUpdateResult> {
  const runNpmInstall = options.runNpmInstall ?? defaultRunNpmInstall;
  await runNpmInstall(`kvy-cli@${options.version}`);
  return { applied: true, installKind: "npm" };
}

export async function applyUpdate(options: ApplyUpdateOptions): Promise<ApplyUpdateResult> {
  switch (options.installKind) {
    case "standalone-binary":
      return applyStandaloneBinaryUpdate(options);
    case "npm":
      return applyNpmUpdate(options);
    case "dev":
      return {
        applied: false,
        reason: "running from source (dev mode). Update via 'git pull' / 'pnpm install' instead",
      };
  }
}
