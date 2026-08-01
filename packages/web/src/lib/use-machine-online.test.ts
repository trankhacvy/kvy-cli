import type { MachineRow } from "@kvy/wire";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { syncQueryKey } from "@/sync/queryKeys";
import type { SyncSnapshot } from "@/sync/types";
import { useMachineOnline } from "./use-machine-online";

/**
 * `useMachineOnline` composes `useMachinePresence` (a `useEffect`
 * subscription that never runs under `renderToStaticMarkup` — this
 * package's vitest has no jsdom, same constraint `use-machine-crypto.test.ts`
 * documents) with the `['sync']` snapshot. So every case here exercises the
 * "no live presence event has arrived yet" frame, falling back to
 * `deriveMachineStatus`'s `lastSeenAt` heuristic — the live-event-flips-it
 * case is already covered at that lower level by
 * `use-machine-presence.test.ts`, without needing a re-render this package
 * can't produce.
 */
function makeMachine(overrides: Partial<MachineRow> = {}): MachineRow {
  return {
    id: "mach-1",
    accountId: "acc-1",
    metadata: { value: { t: "enc", v: 1, c: "meta" }, version: 1 },
    daemonState: null,
    dek: "dek-opaque",
    lastSeenAt: null,
    ...overrides,
  };
}

function renderOnline(machineId: string | null, machines: MachineRow[]) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(syncQueryKey, {
    headerSeq: 1,
    accountKeyEpoch: 1,
    sessions: [],
    machines,
    unmanagedSessions: [],
    workspaces: [],
  } satisfies SyncSnapshot);
  let captured: ReturnType<typeof useMachineOnline> | undefined;
  function Harness() {
    captured = useMachineOnline(machineId);
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
  if (!captured) throw new Error("Harness never rendered");
  return captured;
}

describe("useMachineOnline", () => {
  const now = Date.now();

  it("is unknown, not offline, when machineId is null", () => {
    expect(renderOnline(null, [makeMachine()])).toEqual({
      availability: "unknown",
      isKnownUnavailable: false,
      reason: null,
    });
  });

  it("is unknown, not offline, when the requested machineId isn't in the synced snapshot yet", () => {
    expect(renderOnline("mach-missing", [makeMachine({ id: "mach-1" })])).toEqual({
      availability: "unknown",
      isKnownUnavailable: false,
      reason: null,
    });
  });

  it("is online for a machine with a fresh lastSeenAt heartbeat and no live event yet", () => {
    const state = renderOnline("mach-1", [makeMachine({ id: "mach-1", lastSeenAt: now - 1000 })]);
    expect(state).toEqual({ availability: "online", isKnownUnavailable: false, reason: null });
  });

  it("is offline, with copy, for a machine whose lastSeenAt is well past the recency window", () => {
    const state = renderOnline("mach-1", [
      makeMachine({ id: "mach-1", lastSeenAt: now - 10 * 60_000 }),
    ]);
    expect(state.availability).toBe("offline");
    expect(state.isKnownUnavailable).toBe(true);
    expect(state.reason).toMatch(/offline/i);
  });

  it("is needs-reauth, with its own distinct copy, for a machine whose bootstrap row flags it", () => {
    const state = renderOnline("mach-1", [
      makeMachine({ id: "mach-1", lastSeenAt: now, needsReauth: true }),
    ]);
    expect(state.availability).toBe("needs-reauth");
    expect(state.isKnownUnavailable).toBe(true);
    expect(state.reason).toMatch(/sign in again/i);
  });

  it("never collapses needs-reauth into the plain offline copy", () => {
    const offline = renderOnline("mach-1", [
      makeMachine({ id: "mach-1", lastSeenAt: now - 10 * 60_000 }),
    ]);
    const needsReauth = renderOnline("mach-1", [
      makeMachine({ id: "mach-1", lastSeenAt: now, needsReauth: true }),
    ]);
    expect(offline.reason).not.toEqual(needsReauth.reason);
  });
});
