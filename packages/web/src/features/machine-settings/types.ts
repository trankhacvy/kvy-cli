import type { SleepInhibitMode, SleepInhibitState } from "@kvy/wire";

/**
 * View-model types for Settings → Machines' Sleep Inhibit card —
 * structurally cloned from
 * `features/provider-accounts/types.ts`.
 *
 * `SleepInhibitMode`/`SleepInhibitState` are re-exported straight off
 * `@kvy/wire` rather than redeclared — same "the RPC result is already
 * exactly what this screen wants to render" precedent as
 * `ProviderAccountSnapshot`.
 */
export type { SleepInhibitMode, SleepInhibitState };

/**
 * The RPC surface this feature needs, seamed off from *how* the call
 * reaches the daemon — mirrors `ProviderAccountActions` exactly. Real
 * default (`use-live-machine-settings-actions.ts`) is
 * `machineRpcToMachineSettingsActions(createMachineRpcClient({...}))`;
 * `mock-source.ts`'s mock stays exported for tests/standalone review.
 */
export interface MachineSettingsActions {
  /** Fetches the target machine's current sleep-inhibit state. Never throws for "unsupported platform" — that's a valid, honest result (`supported: false`); only a genuine transport/RPC failure throws. */
  fetchSleepInhibit(): Promise<SleepInhibitState>;
  /** Applies `mode` on the target machine and returns the post-apply state — no follow-up `fetchSleepInhibit` needed. */
  setSleepInhibit(mode: SleepInhibitMode): Promise<SleepInhibitState>;
}

/** One machine-settings actions client per chosen machine — mirrors `UseProviderAccountActions`. */
export type UseMachineSettingsActions = (machineId: string) => MachineSettingsActions;
