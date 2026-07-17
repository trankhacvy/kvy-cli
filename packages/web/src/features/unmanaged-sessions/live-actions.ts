import type { MachineRpcClient } from "@/sync/machineRpc";
import type { UnmanagedActions } from "./types";

/**
 * Adapts a `MachineRpcClient` (`@/sync/machineRpc.ts`) to the
 * `UnmanagedActions` surface the mirror view + Take Over / Fork Instead
 * dialog consume — one-line seam, mirrors `features/new-session`'s
 * `machineRpcToActions`. Swapping the mock default
 * (`mock-source.ts`'s `useMockUnmanagedActions`) for
 * `(machineId) => machineRpcToUnmanagedActions(createMachineRpcClient({...}))`
 * once a screen has a live `apiSocket` + a crypto client holding the chosen
 * machine's unwrapped DEK is the only change needed at the call site.
 */
export function machineRpcToUnmanagedActions(rpc: MachineRpcClient): UnmanagedActions {
  return {
    async mirror(providerSessionId, cursor) {
      return rpc.call("adopt.mirror", {
        idempotencyKey: crypto.randomUUID(),
        providerSessionId,
        cursor,
      });
    },

    async take(providerSessionId, mode) {
      return rpc.call("adopt.take", {
        idempotencyKey: crypto.randomUUID(),
        providerSessionId,
        mode,
      });
    },
  };
}
