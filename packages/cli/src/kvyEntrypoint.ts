import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

/**
 * Returns the argv that re-invokes this same kvy process — used by every
 * "restart myself in the background/detached" call site (`daemon start-sync`,
 * spawning a provider session, resuming, adopting). Works identically under
 * `tsx`, as `node dist/index.mjs`, via the `bin/kvy.mjs` shim, AND as a
 * compiled Node SEA binary.
 *
 * The SEA case needs its own branch: `process.argv[1]` is the on-disk entry
 * script path in every other mode, but for a compiled single-executable
 * binary there IS no separate entry script — `process.argv[1]` is just the
 * first CLI word (e.g. `"daemon"`). Appending it as if it were a script path
 * produces a garbled re-invocation (`kvy daemon daemon start-sync`) whose
 * child mis-parses its own argv and tries to spawn a daemon again itself —
 * confirmed by an E2E run against a real compiled binary: an unbounded fork
 * storm, 16+ processes before being killed. `process.execPath` alone is
 * already the full command for a SEA binary, so no entry gets appended.
 */
export function defaultKvyEntrypoint(): [string, ...string[]] {
  if (isSea()) {
    return [process.execPath, ...process.execArgv];
  }
  const entry = process.argv[1] ?? fileURLToPath(import.meta.url);
  return [process.execPath, ...process.execArgv, entry];
}
