import { useMemo } from "react";
import type {
  MachineSettingsActions,
  SleepInhibitMode,
  SleepInhibitState,
  UseMachineSettingsActions,
} from "./types";

/**
 * Settings → Machines' default data source — mirrors `features/
 * provider-accounts/mock-source.ts`'s role: a live per-machine crypto client
 * isn't guaranteed to be ready everywhere this feature might be reviewed
 * standalone, so this simulates the daemon's `sleepInhibit.get`/
 * `sleepInhibit.set` RPCs against realistic-looking fixture state, kept to
 * the same call signature (`MachineSettingsActions`) so swapping in the real
 * `machineRpcToMachineSettingsActions` is a one-line change at the call
 * site.
 *
 * One supported darwin machine (`mach-darwin`) and one unsupported linux
 * machine (`mach-linux`) — mirroring this feature's own acceptance
 * criterion that the disabled "macOS only" state renders correctly.
 *
 * State is held per `createMockMachineSettingsActions` call (a plain closure
 * variable), NOT in a module-level map — each call gets its own independent
 * mutable state, matching a real machine's own daemon-local state without
 * leaking mutations between unrelated callers/tests.
 */

const LATENCY_MS = 150;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function initialStateFor(machineId: string): SleepInhibitState {
  if (machineId === "mach-linux") {
    return { supported: false, platform: "linux", mode: "off", active: false };
  }
  return { supported: true, platform: "darwin", mode: "off", active: false };
}

export function createMockMachineSettingsActions(machineId: string): MachineSettingsActions {
  let state = initialStateFor(machineId);

  return {
    async fetchSleepInhibit() {
      await delay(LATENCY_MS);
      return state;
    },
    async setSleepInhibit(mode: SleepInhibitMode) {
      await delay(LATENCY_MS);
      // Unsupported machines never actually change mode, matching the real
      // RPC's honesty contract (`SleepInhibitState.supported: false` always
      // reports `mode: "off"`/`active: false` regardless of the requested mode).
      state = state.supported ? { ...state, mode, active: mode !== "off" } : state;
      return state;
    },
  };
}

/** `useMemo`'d on `machineId` so a real hook backed by a live `MachineSettingsActions` client (which shouldn't reseal/reconnect every render) can be swapped in without changing this call site's shape. */
export const useMockMachineSettingsActions: UseMachineSettingsActions = (machineId) =>
  useMemo(() => createMockMachineSettingsActions(machineId), [machineId]);
