/**
 * Daemon self-update detection (design §8: "Self-update: watch installed
 * artifact mtime (not version string); restart when idle"; plan.md §16
 * "3.2 Durability").
 *
 * Compares the built CLI bundle's (`dist/index.mjs`) mtime captured at
 * daemon startup against its current mtime on every heartbeat tick. A
 * package manager replacing the installed CLI (`npm i -g falcon`, a fresh
 * `curl | sh` re-run, etc.) rewrites that file on disk; the already-running
 * daemon keeps executing the *old* in-memory code until something restarts
 * it — this module is purely the detection half of that.
 *
 * **Why mtime, not the `package.json` version string:** Happy's daemon used
 * to compare `package.json`'s version field on disk against its own
 * compiled-in version, which produced an infinite restart loop
 * (github.com/slopus/happy#1107) whenever a deprecation/republish bumped
 * `package.json`'s version without actually rebuilding `dist/` — the
 * version string changed but the bundle didn't, so every restart
 * re-triggered another "update" detection forever. A file's mtime only
 * changes when the bundle itself is actually rewritten, which is the only
 * event that actually matters here.
 *
 * **Why "restart when idle", not immediately:** restarting out from under
 * an in-flight spawn/resume RPC — or a session mid-`/session-started`
 * webhook — would tear down the control server and (once wired) the
 * machine WS connection at exactly the wrong moment. This module only
 * *detects* the replacement; `commands.ts`'s heartbeat decides when it's
 * safe to act on it, gated on the session registry reporting no live
 * sessions (`SessionRegistry.hasLiveSessions()`).
 */
import { statSync } from "node:fs";

/**
 * Captures `entryPath`'s current mtime, or `null` if it can't be read (e.g.
 * dev mode via `tsx src/index.ts`, which has no built `dist/index.mjs` to
 * watch at all). `null` means "self-update detection is disabled for this
 * run" — the same effective behavior Happy's dev mode has, just reached via
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
