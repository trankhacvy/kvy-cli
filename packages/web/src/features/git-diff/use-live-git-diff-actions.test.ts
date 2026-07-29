import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { syncQueryKey } from "@/sync/queryKeys";
import type { SyncSnapshot } from "@/sync/types";
import { useLiveGitDiffActions } from "./use-live-git-diff-actions";

// Same fact `features/new-session/live-source.test.ts` relies on:
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
  let captured: ReturnType<typeof useLiveGitDiffActions> | undefined;
  function Harness() {
    captured = useLiveGitDiffActions(machineId);
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
  if (captured === undefined) throw new Error("Harness never rendered");
  return captured;
}

describe("useLiveGitDiffActions", () => {
  it("rejects fetchStatus/fetchDiff with an honest 'key isn't unwrapped yet' message before the machine key has unwrapped", async () => {
    const actions = renderActions("mach-1");
    await expect(actions.fetchStatus("/repo")).rejects.toThrow(/isn't unwrapped yet/i);
    await expect(actions.fetchDiff("/repo")).rejects.toThrow(/isn't unwrapped yet/i);
  });

  it("rejects commit/push/renameBranch/listBranches the same way before the machine key has unwrapped", async () => {
    const actions = renderActions("mach-1");
    await expect(actions.commit("/repo", "fix")).rejects.toThrow(/isn't unwrapped yet/i);
    await expect(actions.push("/repo")).rejects.toThrow(/isn't unwrapped yet/i);
    await expect(actions.renameBranch("/repo", "renamed")).rejects.toThrow(/isn't unwrapped yet/i);
    await expect(actions.listBranches("/repo")).rejects.toThrow(/isn't unwrapped yet/i);
  });
});
