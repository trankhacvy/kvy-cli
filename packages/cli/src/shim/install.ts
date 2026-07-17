/**
 * `falcon shim install` — writes `~/.falcon/bin/{claude,codex}` PATH shims
 * and appends the PATH block (`rcBlock.ts`) to the user's preferred rc file
 * (`paths.ts`'s `preferredRcFile`). falcon-prd.md FR-9.6, plan.md §16 "4.2
 * Adoption Tier 3 + polish".
 *
 * Each shim is a plain POSIX shell script that execs the real `falcon`
 * binary with the shimmed provider name prepended — `claude`/`codex`
 * invocations that resolve to `~/.falcon/bin` (once it's on PATH) become
 * `falcon claude`/`falcon codex` transparently. Both the binary writes and
 * the rc-file edit land via tmp-file + rename, so a concurrent reader (or a
 * process crash mid-write) never observes a partial file.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  preferredRcFile,
  type ShimBinaryName,
  type ShimPathsOptions,
  shimBinaryNames,
  shimBinaryPath,
  shimBinDir,
} from "./paths.js";
import { insertRcBlock } from "./rcBlock.js";

function shimScript(name: ShimBinaryName): string {
  return [
    "#!/usr/bin/env sh",
    "# Installed by `falcon shim install` — do not edit by hand.",
    "# Remove with `falcon shim uninstall`.",
    `exec falcon ${name} "$@"`,
    "",
  ].join("\n");
}

export interface ShimInstallResult {
  binDir: string;
  installedBinaries: string[];
  rcFile: string;
  /** `false` when the rc file already had the PATH block (no write happened). */
  rcFileUpdated: boolean;
}

export async function installShim(options: ShimPathsOptions = {}): Promise<ShimInstallResult> {
  const binDir = shimBinDir(options);
  await mkdir(binDir, { recursive: true });

  const installedBinaries: string[] = [];
  for (const name of shimBinaryNames()) {
    const target = shimBinaryPath(name, options);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, shimScript(name), "utf8");
    await chmod(tmp, 0o755);
    await rename(tmp, target);
    installedBinaries.push(target);
  }

  const rc = preferredRcFile(options);
  await mkdir(path.dirname(rc.path), { recursive: true });
  const existing = existsSync(rc.path) ? await readFile(rc.path, "utf8") : "";
  const updated = insertRcBlock(existing, rc.syntax);
  const rcFileUpdated = updated !== existing;
  if (rcFileUpdated) {
    const tmp = `${rc.path}.tmp`;
    await writeFile(tmp, updated, "utf8");
    await rename(tmp, rc.path);
  }

  return { binDir, installedBinaries, rcFile: rc.path, rcFileUpdated };
}
