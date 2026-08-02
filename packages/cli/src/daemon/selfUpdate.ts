/**
 * Daemon self-update detection: compares the CLI bundle's mtime at startup
 * against its current mtime on each heartbeat tick.
 *
 * mtime is used (not the package.json version string) because comparing version
 * strings triggers false positives when a republish updates package.json without
 * rebuilding dist/ - causing an infinite restart loop.
 *
 * Detection only: `commands.ts`'s heartbeat decides when it's safe to restart,
 * gated on no live sessions.
 */
import { statSync } from "node:fs";

/**
 * Captures `entryPath`'s current mtime, or `null` if it can't be read (e.g.
 * dev mode via `tsx src/index.ts`, which has no built `dist/index.mjs` to
 * watch at all). `null` means "self-update detection is disabled for this
 * a missing file instead of a special-cased branch.
 */
export function captureBundleMtimeMs(entryPath: string): number | null {
  try {
    return statSync(entryPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * `true` iff `entryPath`'s mtime has changed since `initialMtimeMs` was
 * captured. Always `false` when `initialMtimeMs` is `null` (detection
 * disabled) or the file is transiently unreadable (e.g. mid-install) — a
 * missing/unreadable file is never itself evidence of a replacement; the
 * next heartbeat tick simply checks again.
 */
export function hasBundleBeenReplaced(entryPath: string, initialMtimeMs: number | null): boolean {
  if (initialMtimeMs === null) return false;
  try {
    return statSync(entryPath).mtimeMs !== initialMtimeMs;
  } catch {
    return false;
  }
}
