/**
 * The FR-9.6 "opt-in at onboarding" prompt — offered once, right after a
 * successful `falcon auth login` (wired from `index.ts`'s `runAuth`), since
 * that's the first moment a fresh install has proven there's a real account
 * behind it (plan.md §16 "4.2 Adoption Tier 3 + polish").
 *
 * Gated on `persistence.ts`'s `Settings.onboardingCompleted` — this is that
 * field's first real consumer — so it never asks twice regardless of the
 * answer: declining just means "ask me later" becomes "run `falcon shim
 * install` yourself later", not "ask again next login". Skipped outright in
 * non-interactive contexts (CI, scripts, piped stdin) where there's no one
 * to answer it — those runs still mark onboarding complete so a later
 * interactive run doesn't surprise the user with a stale prompt.
 */

import type { PersistenceOptions } from "../persistence.js";
import { readSettings, updateSettings } from "../persistence.js";
import { installShim } from "./install.js";
import type { ShimPathsOptions } from "./paths.js";

export interface OnboardingPromptDeps {
  persistenceOptions?: PersistenceOptions;
  shimOptions?: ShimPathsOptions;
  write?: (text: string) => void;
  /** Test seam for the y/n question; defaults to reading a line from stdin. */
  confirm?: (question: string) => Promise<boolean>;
  /** Test seam; defaults to `process.stdin.isTTY === true`. */
  isInteractive?: boolean;
}

async function defaultConfirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Runs at most once per install — a no-op once `onboardingCompleted` is
 * already `true`. Never throws: a failed shim install (e.g. a permission
 * error on some rc file) is reported to the user but never fails the
 * surrounding `falcon auth login`.
 */
export async function maybePromptShimOptIn(deps: OnboardingPromptDeps = {}): Promise<void> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const settings = await readSettings(deps.persistenceOptions);
  if (settings.onboardingCompleted) return;

  const interactive = deps.isInteractive ?? process.stdin.isTTY === true;
  if (interactive) {
    const confirm = deps.confirm ?? defaultConfirm;
    write(
      "\nFalcon can install a shell shim so plain `claude`/`codex` commands automatically run under Falcon.\n" +
        "This is opt-in and reversible (`falcon shim uninstall`).\n",
    );
    const accepted = await confirm("Install the shell shim now? [y/N] ");

    if (accepted) {
      try {
        const result = await installShim(deps.shimOptions);
        write(`Installed shims: ${result.installedBinaries.join(", ")}\n`);
        write(
          result.rcFileUpdated
            ? `Added ${result.binDir} to PATH in ${result.rcFile}. Restart your shell (or run \`source ${result.rcFile}\`) for it to take effect.\n`
            : `${result.rcFile} already has ${result.binDir} on PATH.\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        write(
          `Could not install the shell shim: ${message}\nRun \`falcon shim install\` to retry later.\n`,
        );
      }
    } else {
      write("Skipped. Run `falcon shim install` any time to enable it later.\n");
    }
  }

  await updateSettings(
    (current) => ({ ...current, onboardingCompleted: true }),
    deps.persistenceOptions,
  );
}
