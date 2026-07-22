import type { MachineRpcClient } from "@/sync/machineRpc";
import type { ProviderAccountActions } from "./types";

/**
 * Adapts a `MachineRpcClient` (`@/sync/machineRpc.ts`) to the
 * `ProviderAccountActions` surface Settings → Providers consumes — a
 * one-line seam mirroring `features/git-diff/live-actions.ts`'s
 * `machineRpcToGitDiffActions`.
 */
export function machineRpcToProviderAccountActions(rpc: MachineRpcClient): ProviderAccountActions {
  return {
    async fetchAccount(provider) {
      return rpc.call("provider.account", { idempotencyKey: crypto.randomUUID(), provider });
    },
  };
}
