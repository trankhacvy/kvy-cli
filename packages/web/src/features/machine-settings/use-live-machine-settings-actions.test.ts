import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { syncQueryKey } from "@/sync/queryKeys";
import type { SyncSnapshot } from "@/sync/types";
import { useLiveMachineSettingsActions } from "./use-live-machine-settings-actions";

// Same fact `features/provider-accounts/use-live-provider-account-actions.test.ts`
// relies on: `renderToStaticMarkup` never flushes effects, so
// `useMachineCrypto`'s unwrap effect never runs and `crypto` stays `null`
// for the whole test — this is the "machine key not unwrapped yet" frame
// every real mount also passes through before the DEK resolves.
function renderActions(machineId: string) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(syncQueryKey, {
    headerSeq: 1,
    accountKeyEpoch: 1,
    sessions: [],
    machines: [],
    unmanagedSessions: [],
    workspaces: [],
  } satisfies SyncSnapshot);
  let captured: ReturnType<typeof useLiveMachineSettingsActions> | undefined;
  function Harness() {
    captured = useLiveMachineSettingsActions(machineId);
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
  if (captured === undefined) throw new Error("Harness never rendered");
  return captured;
}

describe("useLiveMachineSettingsActions (docs/features/sleep-inhibit.md)", () => {
  it("rejects fetchSleepInhibit with an honest 'key isn't unwrapped yet' message before the machine key has unwrapped", async () => {
    const actions = renderActions("mach-1");
    await expect(actions.fetchSleepInhibit()).rejects.toThrow(/isn't unwrapped yet/i);
  });

  it("rejects setSleepInhibit the same way before the machine key has unwrapped", async () => {
    const actions = renderActions("mach-1");
    await expect(actions.setSleepInhibit("always")).rejects.toThrow(/isn't unwrapped yet/i);
  });
});
