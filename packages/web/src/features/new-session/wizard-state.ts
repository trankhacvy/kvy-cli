import type { PermissionMode } from "@falcon/wire";
import type { NewSessionProvider, SpawnRequest } from "./types";

/**
 * Pure step/form logic for the New Session wizard — no React, no RPC calls,
 * fully unit-testable (mirrors `features/session-list/group.ts` and
 * `features/session-control/session-state.ts`'s "derive, don't store"
 * pattern). `new-session-screen.tsx` is the only caller.
 */

export const WIZARD_STEPS = ["machine", "directory", "options", "review"] as const;
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
};

/** Whether the wizard can move past `step` given the current form state. */
export function canAdvance(step: WizardStep, form: NewSessionForm): boolean {
  switch (step) {
    case "machine":
      return form.machineId !== null;
    case "directory":
      return form.directory !== null;
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
  };
}
