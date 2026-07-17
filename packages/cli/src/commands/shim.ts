/**
 * `falcon shim install/uninstall/status` (falcon-prd.md FR-9.6, plan.md §16
 * "4.2 Adoption Tier 3 + polish", design §7.2: "bin/ — optional shims (Tier
 * 3 adoption): claude, codex → falcon"). Thin CLI wiring over
 * `../shim/{install,uninstall,status}.ts` — see those for the actual
 * bin-file / PATH-block logic.
 */
import { installShim } from "../shim/install.js";
import type { ShimPathsOptions } from "../shim/paths.js";
import { shimStatus } from "../shim/status.js";
import { uninstallShim } from "../shim/uninstall.js";

export type ShimCommandAction = "install" | "uninstall" | "status";

export interface ShimCommandDeps {
  shimOptions?: ShimPathsOptions;
  write?: (text: string) => void;
}

export async function runShimCommand(
  action: ShimCommandAction,
  deps: ShimCommandDeps = {},
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const options = deps.shimOptions ?? {};

  switch (action) {
    case "install": {
      const result = await installShim(options);
      write(`Installed shims: ${result.installedBinaries.join(", ")}\n`);
      write(
        result.rcFileUpdated
          ? `Added ${result.binDir} to PATH in ${result.rcFile}. Restart your shell (or run \`source ${result.rcFile}\`) for it to take effect.\n`
          : `${result.rcFile} already has ${result.binDir} on PATH.\n`,
      );
      return 0;
    }
    case "uninstall": {
      const result = await uninstallShim(options);
      write(
        result.removedBinaries.length > 0
          ? `Removed shims: ${result.removedBinaries.join(", ")}\n`
          : "No shims were installed.\n",
      );
      write(
        result.updatedRcFiles.length > 0
          ? `Removed the Falcon PATH block from: ${result.updatedRcFiles.join(", ")}\n`
          : "No rc files had a Falcon PATH block.\n",
      );
      return 0;
    }
    case "status": {
      const status = await shimStatus(options);
      write("falcon shim status\n");
      write(`  bin dir:     ${status.binDir}\n`);
      write(
        `  installed:   ${status.installedBinaries.length > 0 ? status.installedBinaries.join(", ") : "(none)"}\n`,
      );
      if (status.missingBinaries.length > 0) {
        write(`  missing:     ${status.missingBinaries.join(", ")}\n`);
      }
      write(
        `  PATH block:  ${status.rcFilesWithBlock.length > 0 ? status.rcFilesWithBlock.join(", ") : "(not configured)"}\n`,
      );
      write(
        `  on PATH now: ${status.binDirOnPath ? "yes" : "no (restart your shell after install)"}\n`,
      );
      return 0;
    }
  }
}
