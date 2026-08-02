/**
 * Distribution & self-host": "CLI self-update (`cli-latest` rolling tag,
 * atomic replace, `KVY_NO_UPDATE`)"). Mirrors `scripts/install.sh`'s own
 * `KVY_REPO` default exactly, and `packages/cli/package.json`'s
 * `repository.url` — same GitHub slug every other distribution surface
 * (installer script, release workflow) already points at.
 */

const DEFAULT_REPO = "kvy-dev/kvy";

/** `owner/repo` on GitHub — same override convention as `scripts/install.sh`. */
export function resolveUpdateRepo(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KVY_REPO?.trim();
  return override || DEFAULT_REPO;
}

/**
 * `true` iff the user has opted out via `KVY_NO_UPDATE` (any non-empty,
 * non-"0"/"false" value counts — same permissive truthiness every other
 * `KVY_*` boolean-ish env var in this codebase uses, e.g.
 * `KVY_NO_SERVICE`/`KVY_DEBUG`).
 */
export function isUpdateOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.KVY_NO_UPDATE?.trim().toLowerCase();
  return raw !== undefined && raw !== "" && raw !== "0" && raw !== "false";
}

/** Set by `autoUpdateTrigger.ts`'s detached child spawn so `runUpdateCommand` knows to stay quiet on stdout (nothing reads a backgrounded child's terminal) and never treat a failed check as fatal. */
export function isBackgroundUpdateRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KVY_UPDATE_SILENT === "1";
}

/** How long the version-check network request may take before giving up — bounded so a hung/unreachable GitHub never leaves an explicit `kvy update` (or the background check child) hanging indefinitely. */
export const UPDATE_CHECK_TIMEOUT_MS = 5_000;

/** How long the binary download itself may take — larger, since the compiled binaries are tens of MB. */
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 60_000;

export const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function releaseAssetUrl(repo: string, assetName: string): string {
  return `https://github.com/${repo}/releases/download/cli-latest/${assetName}`;
}
