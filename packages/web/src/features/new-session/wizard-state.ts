import type { PermissionMode } from "@falcon/wire";
import type { ImportCandidate, NewSessionProvider, SpawnRequest } from "./types";

/**
 * Pure step/form logic for the New Session wizard — no React, no RPC calls,
 * fully unit-testable (mirrors `features/session-list/group.ts` and
 * `features/session-control/session-state.ts`'s "derive, don't store"
 * pattern). `new-session-screen.tsx` is the only caller.
 */

export const WIZARD_STEPS = ["machine", "directory", "import", "options", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface NewSessionForm {
  machineId: string | null;
  directory: string | null;
  provider: NewSessionProvider;
  permissionMode: PermissionMode;
  /** Free-text model override; empty string means "use the provider's default". */
  model: string;
  branchEnabled: boolean;
  branchName: string;
  createWorktree: boolean;
  /** The session-import step's pick (falcon-prd.md FR-7.8 UC7), or `null` to start fresh — the default, and always a valid choice (the step is optional). */
  importCandidate: ImportCandidate | null;
}

export const INITIAL_FORM: NewSessionForm = {
  machineId: null,
  directory: null,
  provider: "claude-code",
  permissionMode: "default",
  model: "",
  branchEnabled: false,
  branchName: "",
  createWorktree: true,
  importCandidate: null,
};

/** Whether the wizard can move past `step` given the current form state. */
export function canAdvance(step: WizardStep, form: NewSessionForm): boolean {
  switch (step) {
    case "machine":
      return form.machineId !== null;
    case "directory":
      return form.directory !== null;
    case "import":
      // Optional step — "start a new session" (importCandidate: null) is a valid choice.
      return true;
    case "options":
      return !form.branchEnabled || form.branchName.trim() !== "";
    case "review":
      return true;
  }
}

export function nextStep(step: WizardStep): WizardStep {
  const i = WIZARD_STEPS.indexOf(step);
  return WIZARD_STEPS.at(Math.min(i + 1, WIZARD_STEPS.length - 1)) ?? step;
}

export function previousStep(step: WizardStep): WizardStep {
  const i = WIZARD_STEPS.indexOf(step);
  return WIZARD_STEPS.at(Math.max(i - 1, 0)) ?? step;
}

/** Builds the `spawn` request from a complete form. Throws if `machineId`/`directory` haven't been picked yet — callers only invoke this from the "review" step, where `canAdvance` has already gated entry. */
export function buildSpawnRequest(form: NewSessionForm): SpawnRequest {
  if (form.directory === null) {
    throw new Error("cannot build a spawn request before a directory is chosen");
  }
  const model = form.model.trim();
  return {
    directory: form.directory,
    provider: form.provider,
    permissionMode: form.permissionMode,
    model: model === "" ? undefined : model,
    branch: form.branchEnabled
      ? { name: form.branchName.trim(), createWorktree: form.createWorktree }
      : undefined,
    continueFrom: form.importCandidate
      ? { providerSessionId: form.importCandidate.providerSessionId }
      : undefined,
  };
}
