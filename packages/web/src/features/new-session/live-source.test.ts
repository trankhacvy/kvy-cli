import type { EncryptedBox, MachineRow } from "@falcon/wire";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { syncQueryKey } from "@/sync/queryKeys";
import type { SyncSnapshot } from "@/sync/types";
import { useLiveNewSessionActions } from "./live-source";
import type { NewSessionActions } from "./types";

// Neither `useCryptoBridge` (worker spun up in a `useEffect`) nor
// `useMachineCrypto`'s own unwrap effect ever runs under
// `renderToStaticMarkup` (it never flushes effects — same fact
// `require-auth.test.ts` relies on), so every render in this file is the
// deterministic "crypto not ready yet" frame: `crypto` stays `null` for the
// lifetime of the test. That's exactly the state `useLiveNewSessionActions`'
// fallback path ("not ready yet" rejection) is for.

function box(c: string): EncryptedBox {
  return { t: "enc", v: 1, c };
}

function makeMachine(overrides: Partial<MachineRow> = {}): MachineRow {
  return {
    id: "mach-1",
    accountId: "acc-1",
    metadata: { value: box("meta-v1"), version: 1 },
    daemonState: null,
    dek: "dek-opaque",
    lastSeenAt: null,
    ...overrides,
  };
}

function renderWithSnapshot<T>(hook: () => T, snapshot: SyncSnapshot): T {
  const queryClient = new QueryClient();
  queryClient.setQueryData(syncQueryKey, snapshot);
  let captured: T | undefined;
  function Harness() {
    captured = hook();
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
  if (captured === undefined) throw new Error("Harness never rendered");
  return captured;
}

function snapshotWithMachines(machines: MachineRow[]): SyncSnapshot {
  return { headerSeq: 1, sessions: [], machines, unmanagedSessions: [], workspaces: [] };
}

describe("useLiveNewSessionActions", () => {
  function renderActions(machineId: string): NewSessionActions {
    return renderWithSnapshot(
      () => useLiveNewSessionActions(machineId),
      snapshotWithMachines([makeMachine()]),
    );
  }

  it("rejects every action method with an honest 'key isn't unwrapped yet' message before the machine key has unwrapped", async () => {
    const actions = renderActions("mach-1");
    await expect(actions.browseDirectory()).rejects.toThrow(/isn't unwrapped yet/i);
    await expect(actions.createDirectory("/tmp")).rejects.toThrow(/isn't unwrapped yet/i);
    await expect(
      actions.spawn({ directory: "/tmp", provider: "claude-code", permissionMode: "default" }),
    ).rejects.toThrow(/isn't unwrapped yet/i);
    await expect(actions.listImportCandidates("/tmp")).rejects.toThrow(/isn't unwrapped yet/i);
    await expect(actions.listBranches("/tmp")).rejects.toThrow(/isn't unwrapped yet/i);
  });

  it("also stays pending for an empty machineId (no machine chosen yet)", async () => {
    const actions = renderActions("");
    await expect(actions.browseDirectory()).rejects.toThrow(/isn't unwrapped yet/i);
  });
});
