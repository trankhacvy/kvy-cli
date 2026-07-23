import type { MachineRpcClient } from "@/sync/machineRpc";
import type { MachineSettingsActions } from "./types";

/**
 * Adapts a `MachineRpcClient` (`@/sync/machineRpc.ts`) to the
 * `MachineSettingsActions` surface Settings → Machines consumes — a
 * one-line seam mirroring `features/provider-accounts/live-actions.ts`'s
 * `machineRpcToProviderAccountActions`.
 */
export function machineRpcToMachineSettingsActions(rpc: MachineRpcClient): MachineSettingsActions {
  return {
    async fetchSleepInhibit() {
      return rpc.call("sleepInhibit.get", { idempotencyKey: crypto.randomUUID() });
    },
    async setSleepInhibit(mode) {
      return rpc.call("sleepInhibit.set", { idempotencyKey: crypto.randomUUID(), mode });
    },
  };
}
