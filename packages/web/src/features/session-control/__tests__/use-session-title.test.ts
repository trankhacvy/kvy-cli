import type { SessionRow } from "@falcon/wire";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { syncQueryKey } from "@/sync/queryKeys";
import type { SyncSnapshot } from "@/sync/types";
import { useSessionTitle } from "../use-session-title";

// Same "pre-effect frame" technique as `lib/use-machine-crypto.test.ts`:
// `useSessionCrypto`'s bridge worker only exists after a `useEffect` runs,
// and `useSessionTitle`'s own decrypt effect is gated on that bridge —
// neither ever fires under `renderToStaticMarkup` (server rendering never
// flushes effects), so every case here exercises "before the box has had
// any chance to be opened", which must always be `null`, never a thrown
// error and never a stale/wrong title.
function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-1",
    accountId: "acc-1",
    workspaceId: "ws-1",
    machineId: "mach-1",
    tag: "sess-1-tag",
    provider: "claude",
    executionTarget: "pty",
    status: "active",
    metadata: { value: { t: "enc", v: 1, c: "meta" }, version: 1 },
    agentState: null,
    dek: "dek-opaque",
    msgSeq: 0,
    notificationsMuted: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function renderTitle(sessionId: string, sessions: SessionRow[]) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(syncQueryKey, {
    headerSeq: 1,
    accountKeyEpoch: 1,
    sessions,
    machines: [],
    unmanagedSessions: [],
    workspaces: [],
  } satisfies SyncSnapshot);
  let captured: string | null | undefined;
  function Harness() {
    captured = useSessionTitle(sessionId);
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
  if (captured === undefined) throw new Error("Harness never rendered");
  return captured;
}

describe("useSessionTitle", () => {
  it("returns null before the crypto bridge worker exists, even when the session's row has synced", () => {
    expect(renderTitle("sess-1", [makeSession({ id: "sess-1" })])).toBeNull();
  });

  it("returns null when the requested sessionId isn't in the synced snapshot at all", () => {
    expect(renderTitle("sess-missing", [makeSession({ id: "sess-1" })])).toBeNull();
  });

  it("returns null against an empty synced snapshot", () => {
    expect(renderTitle("sess-1", [])).toBeNull();
  });
});
