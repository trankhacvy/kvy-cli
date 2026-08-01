/**
 * `kvy adapters install|upgrade` (design §7.9, plan.md §16 "Phase 2.0 —
 * foundation": "`kvy adapters install|upgrade` command"). Terminal-side
 * surface for `../adapters/install.ts`. No daemon interaction — same
 * rationale as `workspace register`/`workspace config`: this is a local
 * npm-prefix install under `~/.kvy/adapters/`, not something the daemon
 * mediates.
 *
 * `install` is idempotent (skips an adapter that's already pinned-version-
 * and-integrity-satisfied); `upgrade` always force-reinstalls every
 * adapter, matching design §7.9's "upgrades are never implicit... the user
 * upgrades deliberately" — both share `runAdaptersCommand`, differing only
 * in `force`.
 */
import type { AdapterInstallDeps, AdapterInstallOutcome } from "../adapters/install.js";
import { installAllAdapters } from "../adapters/install.js";

export interface AdaptersCommandDeps {
  homeDir: string;
  installDeps?: Partial<AdapterInstallDeps>;
  write?: (text: string) => void;
}

function describeOutcome(outcome: AdapterInstallOutcome): string {
  if (!outcome.ok) return `  ${outcome.id}: FAILED: ${outcome.error}`;
  const statusLabel =
    outcome.status === "already-satisfied"
      ? "already up to date"
      : outcome.status === "reinstalled"
        ? "reinstalled"
        : "installed";
  return `  ${outcome.id}: ${statusLabel} (${outcome.version})`;
}

async function runAdapters(
  action: "install" | "upgrade",
  deps: AdaptersCommandDeps,
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const outcomes = await installAllAdapters(
    { homeDir: deps.homeDir, ...deps.installDeps },
    { force: action === "upgrade" },
  );

  write(`kvy adapters ${action}:\n`);
  for (const outcome of outcomes) write(`${describeOutcome(outcome)}\n`);

  return outcomes.some((o) => !o.ok) ? 1 : 0;
}

/** Runs `kvy adapters install`. */
export async function runAdaptersInstallCommand(deps: AdaptersCommandDeps): Promise<number> {
  return runAdapters("install", deps);
}

/** Runs `kvy adapters upgrade`. */
export async function runAdaptersUpgradeCommand(deps: AdaptersCommandDeps): Promise<number> {
  return runAdapters("upgrade", deps);
}
