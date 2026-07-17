/**
 * "How is this `falcon` currently installed?" — the self-update mechanism
 * needs a different apply strategy for each:
 *
 *  - `standalone-binary`: a `bun build --compile` executable
 *    (`scripts/build-binaries.sh`, installed by `scripts/install.sh` or a
 *    manual download). Self-update atomically replaces the running
 *    executable file itself (`applyUpdate.ts`).
 *  - `npm`: installed via `npm install -g falcon` (or run from a built
 *    `dist/index.mjs` in this workspace). Self-update shells out to
 *    `npm install -g falcon@<version>`, reusing the exact publish pipeline
 *    `P4-4.3-standalone-binaries` wired up.
 *  - `dev`: running straight from TypeScript source (`tsx src/index.ts` /
 *    `vitest`) — there is no built artifact to replace, so self-update is a
 *    deliberate no-op (same "detection disabled in dev" precedent
 *    `daemon/selfUpdate.ts` already set for the mtime-watch feature).
 */
import { existsSync } from "node:fs";

export type InstallKind = "standalone-binary" | "npm" | "dev";

export interface DetectInstallKindOptions {
  /**
   * Whether this process is itself a `bun build --compile` binary —
   * callers pass `typeof __FALCON_CLI_VERSION__ !== "undefined"`
   * (`index.ts`'s own compile-time-define check; that identifier is only
   * ever declared in `index.ts`'s module scope, so it can't be referenced
   * from here directly).
   */
  isCompiledBinary: boolean;
  /** `packages/cli/dist/index.mjs` in prod, absent in dev — same file `daemon/selfUpdate.ts` watches. */
  bundlePath: string;
}

export function detectInstallKind(options: DetectInstallKindOptions): InstallKind {
  if (options.isCompiledBinary) return "standalone-binary";
  return existsSync(options.bundlePath) ? "npm" : "dev";
}
