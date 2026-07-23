import type { MachineRpcClient } from "@/sync/machineRpc";
import type { PreviewActions } from "./types";

/**
 * Adapts a `MachineRpcClient` (`@/sync/machineRpc.ts`) to the
 * `PreviewActions` surface the Preview tab consumes — a one-line seam so
 * wiring the real thing in is exactly that: swapping `useMockPreviewActions`
 * for `(machineId) => machineRpcToPreviewActions(createMachineRpcClient({...}))`.
 * Mirrors `features/git-diff/live-actions.ts`'s `machineRpcToGitDiffActions`.
 */
export function machineRpcToPreviewActions(rpc: MachineRpcClient): PreviewActions {
  return {
    async fetchPorts() {
      return rpc.call("preview.ports", { idempotencyKey: crypto.randomUUID() });
    },

    async fetchTunnels() {
      const result = await rpc.call("preview.tunnels", { idempotencyKey: crypto.randomUUID() });
      return result.tunnels;
    },

    async openTunnel(port) {
      return rpc.call("preview.open", { idempotencyKey: crypto.randomUUID(), port });
    },

    async closeTunnel(tunnelId) {
      return rpc.call("preview.close", { idempotencyKey: crypto.randomUUID(), tunnelId });
    },
  };
}
