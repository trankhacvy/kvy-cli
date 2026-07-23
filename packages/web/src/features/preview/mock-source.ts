import { useMemo } from "react";
import type {
  PreviewActions,
  PreviewPortsSnapshot,
  PreviewTunnel,
  UsePreviewActions,
} from "./types";

/**
 * The Preview tab's default data source — mirrors `features/git-diff/
 * mock-source.ts`'s role: `apiSocket`/a live per-machine crypto client
 * aren't wired into every screen yet, so this simulates the daemon's
 * `preview.*` RPCs against a small fixed port list (one already-active
 * tunnel included) kept to the same call signatures (`PreviewActions`) so
 * swapping in the real `machineRpcToPreviewActions` later is a one-line
 * change at the call site.
 */

const LATENCY_MS = 200;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MOCK_PORTS: PreviewPortsSnapshot = {
  cloudflared: { installed: true, version: "2024.6.1" },
  ports: [
    { port: 3000, address: "*", pid: 5421, processName: "node" },
    { port: 5173, address: "127.0.0.1", pid: 5480, processName: "vite" },
    { port: 8080, address: "*", pid: 5502, processName: "node" },
  ],
};

let mockTunnels: PreviewTunnel[] = [
  {
    tunnelId: "tunnel-mock-1",
    port: 3000,
    url: "https://mock-preview-example.trycloudflare.com",
    status: "active",
    startedAt: Date.now() - 5 * 60 * 1000,
  },
];

export function createMockPreviewActions(_machineId: string): PreviewActions {
  return {
    async fetchPorts() {
      await delay(LATENCY_MS);
      return MOCK_PORTS;
    },

    async fetchTunnels() {
      await delay(LATENCY_MS);
      return mockTunnels;
    },

    async openTunnel(port) {
      await delay(LATENCY_MS);
      const existing = mockTunnels.find((t) => t.port === port);
      if (existing) return { tunnelId: existing.tunnelId, url: existing.url, port };
      const tunnel: PreviewTunnel = {
        tunnelId: `tunnel-mock-${port}`,
        port,
        url: `https://mock-${port}-example.trycloudflare.com`,
        status: "active",
        startedAt: Date.now(),
      };
      mockTunnels = [...mockTunnels, tunnel];
      return { tunnelId: tunnel.tunnelId, url: tunnel.url, port };
    },

    async closeTunnel(tunnelId) {
      await delay(LATENCY_MS);
      mockTunnels = mockTunnels.filter((t) => t.tunnelId !== tunnelId);
      return { ok: true };
    },
  };
}

/** `useMemo`'d on `machineId` so a real hook backed by a live `PreviewActions` client (which shouldn't reseal/reconnect every render) can be swapped in without changing this call site's shape. */
export const useMockPreviewActions: UsePreviewActions = (machineId) =>
  useMemo(() => createMockPreviewActions(machineId), [machineId]);
