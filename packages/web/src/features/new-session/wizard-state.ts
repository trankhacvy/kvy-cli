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

/**
 * The New Session wizard's 3-way branch/worktree choice (docs/features/
 * worktree-isolation.md Phase 4, docs/competitive-notes-omnara.md #2):
 * `"repo-root"` — work directly in the main checkout, no branch/worktree
 * involved; `"new-branch"` — start a fresh branch, isolated in a worktree
 * when `createWorktree` is on (the recommended default); `"existing-branch"`
 * — check out an already-existing branch, always in a fresh worktree (the
 * wizard never switches the main checkout's branch out from under the
 * user). Replaces the old flat `branchEnabled` boolean.
 */
export type BranchMode = "repo-root" | "new-branch" | "existing-branch";

export interface NewSessionForm {
  machineId: string | null;
  directory: string | null;
  provider: NewSessionProvider;
  permissionMode: PermissionMode;
  /** Free-text model override; empty string means "use the provider's default". */
  model: string;
  branchMode: BranchMode;
  /** The branch name for `"new-branch"`/`"existing-branch"` mode; ignored (but left as-is, harmlessly) once the user switches back to `"repo-root"`. */
  branchName: string;
  /** Only meaningful in `"new-branch"` mode — `"existing-branch"` always isolates in a fresh worktree regardless of this flag. */
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
  branchMode: "repo-root",
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
      return form.branchMode === "repo-root" || form.branchName.trim() !== "";
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

/**
 * Maps `form.branchMode` (+ `branchName`/`createWorktree`) to
 * `SpawnRequest.branch`: `"repo-root"` → `undefined` (no branch/worktree
 * involved); `"new-branch"` → `{name, createWorktree: form.createWorktree}`
 * (worktree isolation is the recommended default but user-toggleable);
 * `"existing-branch"` → `{name, createWorktree: true}` always — the wizard
 * never switches the main checkout's branch out from under the user, so
 * checking out an existing branch always isolates in a fresh worktree
 * regardless of `form.createWorktree`.
 */
function branchOptionFromForm(
  form: NewSessionForm,
): { name: string; createWorktree: boolean } | undefined {
  switch (form.branchMode) {
    case "repo-root":
      return undefined;
    case "new-branch":
      return { name: form.branchName.trim(), createWorktree: form.createWorktree };
    case "existing-branch":
      return { name: form.branchName.trim(), createWorktree: true };
  }
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
    branch: branchOptionFromForm(form),
    continueFrom: form.importCandidate
      ? { providerSessionId: form.importCandidate.providerSessionId }
      : undefined,
  };
}
