import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { syncQueryKey } from "@/sync/queryKeys";
import type { SyncSnapshot } from "@/sync/types";
import { useLivePreviewActions } from "./use-live-preview-actions";

// Same fact `features/git-diff/use-live-git-diff-actions.test.ts` relies on:
// `renderToStaticMarkup` never flushes effects, so `useMachineCrypto`'s
// unwrap effect never runs and `crypto` stays `null` for the whole test —
// this is the "machine key not unwrapped yet" frame every real mount also
// passes through before the DEK resolves.
function renderActions(machineId: string) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(syncQueryKey, {
    headerSeq: 1,
    sessions: [],
    machines: [],
    unmanagedSessions: [],
    workspaces: [],
  } satisfies SyncSnapshot);
  let captured: ReturnType<typeof useLivePreviewActions> | undefined;
  function Harness() {
    captured = useLivePreviewActions(machineId);
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
  if (captured === undefined) throw new Error("Harness never rendered");
  return captured;
}

describe("useLivePreviewActions", () => {
  it("rejects fetchPorts/fetchTunnels with an honest 'key isn't unwrapped yet' message before the machine key has unwrapped", async () => {
    const actions = renderActions("mach-1");
    await expect(actions.fetchPorts()).rejects.toThrow(/isn't unwrapped yet/i);
    await expect(actions.fetchTunnels()).rejects.toThrow(/isn't unwrapped yet/i);
  });

  it("rejects openTunnel/closeTunnel the same way before the machine key has unwrapped", async () => {
    const actions = renderActions("mach-1");
    await expect(actions.openTunnel(3000)).rejects.toThrow(/isn't unwrapped yet/i);
    await expect(actions.closeTunnel("t1")).rejects.toThrow(/isn't unwrapped yet/i);
  });
});
