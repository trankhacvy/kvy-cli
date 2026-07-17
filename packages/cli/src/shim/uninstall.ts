/**
 * `falcon shim uninstall` — the inverse of `install.ts`: removes the
 * `~/.falcon/bin/{claude,codex}` shims and strips the Falcon PATH block from
 * every rc file that has one (`paths.ts`'s `rcFileCandidates` — not just the
 * one `install` would pick today, since the user's `$SHELL` can differ
 * between install and uninstall). falcon-prd.md FR-9.6.
 */
import { existsSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  rcFileCandidates,
  type ShimPathsOptions,
  shimBinaryNames,
  shimBinaryPath,
} from "./paths.js";
import { removeRcBlock } from "./rcBlock.js";

export interface ShimUninstallResult {
  removedBinaries: string[];
  updatedRcFiles: string[];
}

export async function uninstallShim(options: ShimPathsOptions = {}): Promise<ShimUninstallResult> {
  const removedBinaries: string[] = [];
  for (const name of shimBinaryNames()) {
    const target = shimBinaryPath(name, options);
    if (existsSync(target)) {
      await unlink(target);
      removedBinaries.push(target);
    }
  }

  const updatedRcFiles: string[] = [];
  for (const candidate of rcFileCandidates(options)) {
    if (!existsSync(candidate.path)) continue;
    const content = await readFile(candidate.path, "utf8");
    const updated = removeRcBlock(content);
    if (updated === content) continue;

    const tmp = `${candidate.path}.tmp`;
    await writeFile(tmp, updated, "utf8");
    await rename(tmp, candidate.path);
    updatedRcFiles.push(candidate.path);
  }

  return { removedBinaries, updatedRcFiles };
}
