/**
 * `falcon shim status` — read-only report of what `install`/`uninstall`
 * would act on: which shim binaries exist, which rc file(s) currently carry
 * the PATH block, and whether `~/.falcon/bin` is on *this* process's own
 * PATH (informational only — a freshly-run `install` never retroactively
 * changes the current shell's environment; the user still needs to restart
 * or `source` their rc file).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  rcFileCandidates,
  type ShimPathsOptions,
  shimBinaryNames,
  shimBinaryPath,
  shimBinDir,
} from "./paths.js";
import { hasRcBlock } from "./rcBlock.js";

export interface ShimStatus {
  binDir: string;
  installedBinaries: string[];
  missingBinaries: string[];
  rcFilesWithBlock: string[];
  binDirOnPath: boolean;
}

export async function shimStatus(options: ShimPathsOptions = {}): Promise<ShimStatus> {
  const binDir = shimBinDir(options);

  const installedBinaries: string[] = [];
  const missingBinaries: string[] = [];
  for (const name of shimBinaryNames()) {
    const target = shimBinaryPath(name, options);
    (existsSync(target) ? installedBinaries : missingBinaries).push(target);
  }

  const rcFilesWithBlock: string[] = [];
  for (const candidate of rcFileCandidates(options)) {
    if (!existsSync(candidate.path)) continue;
    const content = await readFile(candidate.path, "utf8");
    if (hasRcBlock(content)) rcFilesWithBlock.push(candidate.path);
  }

  const env = options.env ?? process.env;
  const pathEntries = (env.PATH ?? "").split(path.delimiter);
  const binDirOnPath = pathEntries.includes(binDir);

  return { binDir, installedBinaries, missingBinaries, rcFilesWithBlock, binDirOnPath };
}
