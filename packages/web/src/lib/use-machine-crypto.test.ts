import type { EncryptedBox, MachineRow } from "@falcon/wire";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { syncQueryKey } from "@/sync/queryKeys";
import type { SyncSnapshot } from "@/sync/types";
import { useMachineCrypto } from "./use-machine-crypto";

// `useCryptoBridge`'s worker is spun up in a `useEffect` (see its own doc
// comment) and `useMachineCrypto`'s `setSessionKey`-driven `ready` flip lives
// in a second effect — neither ever runs under `renderToStaticMarkup` (it
// synchronously renders one pass and never flushes effects, the same fact
// `require-auth.test.ts` and the sibling `live-source.test.ts` files in this
// package rely on). So every case here exercises the deterministic
// "before anything has had a chance to unwrap" frame: the hook must return
// `null`, never throw, and never assume a bridge exists.
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

function renderCrypto(machineId: string, machines: MachineRow[]) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(syncQueryKey, {
    headerSeq: 1,
    sessions: [],
    machines,
    unmanagedSessions: [],
    workspaces: [],
  } satisfies SyncSnapshot);
  let captured: ReturnType<typeof useMachineCrypto> | undefined;
  function Harness() {
    captured = useMachineCrypto(machineId);
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
  if (captured === undefined) throw new Error("Harness never rendered");
  return captured;
}

describe("useMachineCrypto", () => {
  it("returns null before the crypto bridge worker exists, even when the machine's row has synced", () => {
    expect(renderCrypto("mach-1", [makeMachine({ id: "mach-1" })])).toBeNull();
  });

  it("returns null when the requested machineId isn't in the synced snapshot at all", () => {
    expect(renderCrypto("mach-missing", [makeMachine({ id: "mach-1" })])).toBeNull();
  });

  it("returns null against an empty synced snapshot", () => {
    expect(renderCrypto("mach-1", [])).toBeNull();
  });
});
