// B5 (new-session-from-web redesign, see the task's own header comment):
// `NewSessionScreen`/`MachineStep`/`DirectoryStep`/`OptionsStep`/`ImportStep`
// — the old free-form wizard's screen and its step components — are
// retired. What's left here are the pieces the new workspace-row inline
// creation panel (`features/session-list/components/new-session-panel.tsx`)
// actually reuses: the extracted pickers, the spawn RPC wiring, and the
// pure request-building/favorites/defaults logic.
export { BaseBranchPicker } from "./components/base-branch-picker";
export { ModelPicker } from "./components/model-picker";
export { PermissionModePicker } from "./components/permission-mode-picker";
export { ProviderPicker } from "./components/provider-picker";
export { getDefaultBranchMode, setDefaultBranchMode } from "./git-defaults";
export { machineRpcToActions } from "./live-actions";
export { useLiveNewSessionActions } from "./live-source";
export { createMockNewSessionActions, useMockNewSessionActions } from "./mock-source";
export {
  buildWorkspacePath,
  displayWorkspacePath,
  validateWorkspaceName,
  WORKSPACE_BASE_DIR,
  WORKSPACE_NAME_ERROR_COPY,
  type WorkspaceNameError,
} from "./new-workspace";
export { runSpawnFlow, SpawnFlowError, type SpawnFlowResult } from "./spawn-flow";
export type {
  BranchItem,
  BranchOption,
  DirectoryEntry,
  DirectoryListing,
  ImportCandidate,
  NewSessionActions,
  NewSessionProvider,
  SpawnOutcome,
  SpawnRequest,
  UseNewSessionActions,
} from "./types";
export { type NewWorkspaceState, useNewWorkspace } from "./use-new-workspace";
export {
  buildSpawnRequest,
  canAdvance,
  INITIAL_FORM,
  type NewSessionForm,
  nextStep,
  previousStep,
  WIZARD_STEPS,
  type WizardStep,
} from "./wizard-state";
