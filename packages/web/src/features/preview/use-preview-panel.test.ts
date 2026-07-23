import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PreviewActions } from "./types";
import { deriveCloudflaredMissing, usePreviewPanel } from "./use-preview-panel";

/**
 * `usePreviewPanel` mixes `useQuery`/`useMutation` — same "no jsdom wired up,
 * but mutate()/invalidateQueries are React-independent" constraint
 * `features/git-diff/use-git-panel.test.ts`'s own doc comment explains.
 */
function fakeActions(overrides: Partial<PreviewActions> = {}): PreviewActions {
  return {
    fetchPorts: vi.fn(async () => ({
      cloudflared: { installed: true, version: "2024.6.1" },
      ports: [{ port: 3000, address: "*", pid: 1, processName: "node" }],
    })),
    fetchTunnels: vi.fn(async () => []),
    openTunnel: vi.fn(async (port: number) => ({
      tunnelId: "t1",
      url: "https://t1.trycloudflare.com",
      port,
    })),
    closeTunnel: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function renderPanel(actions: PreviewActions) {
  const queryClient = new QueryClient();
  let captured: ReturnType<typeof usePreviewPanel> | undefined;
  function Harness() {
    captured = usePreviewPanel(actions, "mach-1");
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
  if (!captured) throw new Error("Harness never rendered");
  return { panel: captured, queryClient };
}

describe("deriveCloudflaredMissing", () => {
  it("is false while the ports query hasn't resolved yet (undefined, not a false positive)", () => {
    expect(deriveCloudflaredMissing(undefined)).toBe(false);
  });

  it("is false once resolved data says cloudflared is installed", () => {
    expect(deriveCloudflaredMissing({ cloudflared: { installed: true }, ports: [] })).toBe(false);
  });

  it("is true once resolved data says cloudflared is NOT installed", () => {
    expect(deriveCloudflaredMissing({ cloudflared: { installed: false }, ports: [] })).toBe(true);
  });
});

describe("usePreviewPanel", () => {
  it("a successful openTunnel invalidates both preview-ports and preview-tunnels", async () => {
    const actions = fakeActions();
    const { panel, queryClient } = renderPanel(actions);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.openTunnel(3000);

    await vi.waitFor(() => {
      expect(actions.openTunnel).toHaveBeenCalledExactlyOnceWith(3000);
    });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["preview-ports", "mach-1"] }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["preview-tunnels", "mach-1"] }),
      );
    });
  });

  it("a failed openTunnel does NOT invalidate either query", async () => {
    const actions = fakeActions({
      openTunnel: vi.fn(async () => {
        throw new Error("cloudflared-not-installed");
      }),
    });
    const { panel, queryClient } = renderPanel(actions);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.openTunnel(3000);

    await vi.waitFor(() => {
      expect(actions.openTunnel).toHaveBeenCalledOnce();
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("a successful closeTunnel invalidates both preview-ports and preview-tunnels", async () => {
    const actions = fakeActions();
    const { panel, queryClient } = renderPanel(actions);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.closeTunnel("t1");

    await vi.waitFor(() => {
      expect(actions.closeTunnel).toHaveBeenCalledExactlyOnceWith("t1");
    });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["preview-ports", "mach-1"] }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["preview-tunnels", "mach-1"] }),
      );
    });
  });
});
