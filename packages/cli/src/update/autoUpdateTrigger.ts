/**
 * Auto-update-on-start (plan.md §16 "4.3 Distribution & self-host":
 * "check a cli-latest rolling tag/version endpoint ... download and
 * atomically replace the running binary/npm install, respect
 * KVY_NO_UPDATE ... fail safe — never block a session start on a
 * failed update check").
 *
 * The actual network check + download + apply all happen in a **detached,
 * unref'd child process** (`kvy update`, re-invoked with
 * `KVY_UPDATE_SILENT=1`) — mirroring `daemon/commands.ts`'s
 * `defaultSpawnStartSync()`, the existing precedent for "re-launch this
 * same entrypoint as a background process". This function itself only
 * touches the filesystem (a rate-limit timestamp) and spawns that child;
 * it never makes a network call and never awaits the child's completion,
 * so it genuinely cannot block — or even meaningfully delay — the session
 * start that triggered it, regardless of network conditions. It's also
 * wrapped end-to-end in a try/catch: any unexpected failure (e.g. a
 * corrupt settings.json, a spawn failure) is logged and swallowed, never
 * surfaced to the caller.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger.js";
import { readSettings, updateSettings } from "../persistence.js";
import { AUTO_UPDATE_CHECK_INTERVAL_MS, isUpdateOptedOut } from "./config.js";
import { detectInstallKind } from "./installKind.js";

export interface MaybeTriggerAutoUpdateOptions {
  isCompiledBinary: boolean;
  bundlePath: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  logger: Logger;
  now?: () => number;
  intervalMs?: number;
  /** Injectable for tests; defaults to a real detached `spawn`. */
  spawnBackgroundUpdate?: () => void;
}

function defaultSpawnBackgroundUpdate(): void {
  const entry = process.argv[1] ?? fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [...process.execArgv, entry, "update"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, KVY_UPDATE_SILENT: "1" },
  });
  child.unref();
}

/**
 * Best-effort, rate-limited trigger. Returns immediately (no network I/O in
 * this function's own body) — always resolves, never rejects.
 */
export async function maybeTriggerAutoUpdate(
  options: MaybeTriggerAutoUpdateOptions,
): Promise<void> {
  try {
    if (isUpdateOptedOut(options.env)) {
      options.logger.debug("auto-update: skipped (KVY_NO_UPDATE set)");
      return;
    }

    const installKind = detectInstallKind({
      isCompiledBinary: options.isCompiledBinary,
      bundlePath: options.bundlePath,
    });
    if (installKind === "dev") {
      options.logger.debug("auto-update: skipped (dev mode)");
      return;
    }

    const now = options.now ?? (() => Date.now());
    const intervalMs = options.intervalMs ?? AUTO_UPDATE_CHECK_INTERVAL_MS;

    const settings = await readSettings({ homeDir: options.homeDir });
    const lastCheckAt = settings.lastUpdateCheckAt ?? 0;
    if (now() - lastCheckAt < intervalMs) {
      options.logger.debug("auto-update: skipped (checked recently)", { lastCheckAt });
      return;
    }

    // Record the attempt before spawning, not after it completes: this
    // caps how often a background child gets spawned to once per interval
    // even if the check itself hangs or fails, rather than retrying on
    // every single `kvy` invocation in the meantime.
    await updateSettings((current) => ({ ...current, lastUpdateCheckAt: now() }), {
      homeDir: options.homeDir,
    });

    const spawnBackgroundUpdate = options.spawnBackgroundUpdate ?? defaultSpawnBackgroundUpdate;
    spawnBackgroundUpdate();
    options.logger.debug("auto-update: background check spawned");
  } catch (error) {
    options.logger.warn("auto-update: trigger failed (non-fatal)", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
