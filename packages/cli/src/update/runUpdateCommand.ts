/**
 * `falcon update` — the explicit, user-facing entrypoint for the
 * self-update mechanism (plan.md §16 "4.3 Distribution & self-host"), and
 * also what `autoUpdateTrigger.ts` spawns as a detached background child on
 * every `falcon` start. Both paths share this exact same check-then-apply
 * logic; the only difference is `silent` (set via `FALCON_UPDATE_SILENT=1`
 * on the background child, since nothing reads a detached process's
 * stdout) gating whether progress is printed.
 *
 * Fails safe throughout: a network error, an unpublished `cli-latest` tag,
 * an unsupported platform, or an `npm install` failure all resolve to a
 * clear message and a non-zero-but-non-throwing result — this function
 * never throws, so a caller (in particular the background auto-update
 * path) never needs a try/catch to stay safe.
 */
import type { Logger } from "../logger.js";
import { type ApplyUpdateOptions, applyUpdate } from "./applyUpdate.js";
import { isBackgroundUpdateRun, resolveUpdateRepo } from "./config.js";
import { fetchLatestVersion } from "./fetchLatestVersion.js";
import { detectInstallKind } from "./installKind.js";
import { isNewerVersion } from "./versionCompare.js";

export interface RunUpdateCommandDeps {
  currentVersion: string;
  isCompiledBinary: boolean;
  bundlePath: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /** Injectable for tests; defaults to the real network implementations. */
  fetchLatestVersionImpl?: typeof fetchLatestVersion;
  applyUpdateImpl?: typeof applyUpdate;
  fetchImpl?: ApplyUpdateOptions["fetchImpl"];
  silent?: boolean;
}

export interface RunUpdateCommandResult {
  code: number;
  message: string;
}

export async function runUpdateCommand(
  deps: RunUpdateCommandDeps,
): Promise<RunUpdateCommandResult> {
  const silent = deps.silent ?? isBackgroundUpdateRun(deps.env);
  const say = (message: string): string => (silent ? "" : message);

  const installKind = detectInstallKind({
    isCompiledBinary: deps.isCompiledBinary,
    bundlePath: deps.bundlePath,
  });

  if (installKind === "dev") {
    const message = "falcon: running from source (dev mode), nothing to self-update\n";
    deps.logger.debug("update: skipped (dev mode)");
    return { code: 0, message: say(message) };
  }

  const repo = resolveUpdateRepo(deps.env);
  const fetchLatest = deps.fetchLatestVersionImpl ?? fetchLatestVersion;

  let latestVersion: string | null;
  try {
    latestVersion = await fetchLatest({ repo, fetchImpl: deps.fetchImpl });
  } catch (error) {
    // fetchLatestVersion already swallows its own errors and returns null —
    // this catch only exists to make that guarantee airtight against a
    // future change to that module, per this command's own "never throw"
    // contract.
    deps.logger.warn("update: version check threw unexpectedly", {
      message: error instanceof Error ? error.message : String(error),
    });
    latestVersion = null;
  }

  if (latestVersion === null) {
    deps.logger.warn("update: could not reach the update endpoint", { repo });
    return {
      code: silent ? 0 : 1,
      message: say(`falcon: could not check for updates (repo: ${repo}). Try again later\n`),
    };
  }

  if (!isNewerVersion(deps.currentVersion, latestVersion)) {
    deps.logger.debug("update: already up to date", {
      currentVersion: deps.currentVersion,
      latestVersion,
    });
    return { code: 0, message: say(`falcon: already up to date (${deps.currentVersion})\n`) };
  }

  deps.logger.info("update: newer version available, applying", {
    currentVersion: deps.currentVersion,
    latestVersion,
    installKind,
  });

  const apply = deps.applyUpdateImpl ?? applyUpdate;
  try {
    const result = await apply({
      installKind,
      repo,
      version: latestVersion,
      execPath: deps.execPath,
      fetchImpl: deps.fetchImpl,
    });

    if (!result.applied) {
      deps.logger.warn("update: apply skipped", { reason: result.reason });
      return { code: silent ? 0 : 1, message: say(`falcon: ${result.reason}\n`) };
    }

    deps.logger.info("update: applied", { latestVersion, installKind });
    return {
      code: 0,
      message: say(
        `falcon: updated ${deps.currentVersion} -> ${latestVersion}. Restart falcon to use the new version\n`,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.error("update: apply failed", { message });
    return { code: silent ? 0 : 1, message: say(`falcon: update failed: ${message}\n`) };
  }
}
