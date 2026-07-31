import type { EncryptedBox, SessionRow } from "@falcon/wire";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { syncQueryKey } from "@/sync/queryKeys";
import type { SyncSnapshot } from "@/sync/types";

// `useSyncSnapshotQuery`'s `enabled: getToken() !== null` needs a token so
// the "no cached snapshot yet" case actually reports `isLoading: true`
// (a disabled query never flips `fetchStatus` to `"fetching"` — verified
// empirically, since `renderToStaticMarkup` never runs the effect that
// would otherwise drive that state in a real mount). `getSync` is mocked to
// a promise that never settles within the test so the (real, network-
// backed) fetch it would otherwise kick off never resolves/rejects mid-run.
vi.mock("@/lib/session", () => ({
  getToken: () => "test-token",
}));
vi.mock("@/lib/api", () => ({
  getSync: () => new Promise<never>(() => {}),
}));

// `GitDiffPanel` pulls in `useGitPanel`/`useLiveGitDiffActions`, a whole
// other query-driven subtree irrelevant to `SessionGitScreen`'s own
// resolve-ids-then-route job — mocked to a marker so these tests assert only
// on what `SessionGitScreen` itself decides to render, mirroring
// `require-auth.test.ts`'s `next/navigation` mock technique for isolating a
// component from a dependency that needs infrastructure this suite doesn't
// set up.
vi.mock("./GitDiffPanel", () => ({
  GitDiffPanel: ({ machineId, worktree }: { machineId: string; worktree: string }) =>
    createElement("div", { "data-testid": "git-diff-panel" }, `${machineId}::${worktree}`),
}));

function box(c: string): EncryptedBox {
  return { t: "enc", v: 1, c };
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-1",
    accountId: "acc-1",
    workspaceId: "ws-1",
    machineId: "mach-1",
    tag: "sess-1",
    provider: "claude-code",
    executionTarget: "local",
    status: "active",
    metadata: { value: box("meta-v1"), version: 1 },
    agentState: null,
    dek: "dek-opaque",
    msgSeq: 0,
    notificationsMuted: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeSnapshot(sessions: SessionRow[]): SyncSnapshot {
  return {
    headerSeq: 1,
    accountKeyEpoch: 1,
    sessions,
    machines: [],
    unmanagedSessions: [],
    workspaces: [],
  };
}

async function renderScreen(sessionId: string, snapshot: SyncSnapshot | undefined) {
  const { SessionGitScreen } = await import("./SessionGitScreen");
  const queryClient = new QueryClient();
  if (snapshot !== undefined) {
    queryClient.setQueryData(syncQueryKey, snapshot);
  }
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SessionGitScreen, { sessionId }),
    ),
  );
}

describe("SessionGitScreen", () => {
  it("shows a loading state before the sync snapshot has populated the cache", async () => {
    const html = await renderScreen("sess-1", undefined);
    expect(html).toContain("Loading session");
    expect(html).not.toContain("git-diff-panel");
  });

  it("shows a not-found state when the session id isn't in the synced snapshot", async () => {
    const html = await renderScreen("sess-missing", makeSnapshot([makeSession()]));
    expect(html).toContain("Could not find session sess-missing");
  });

  it("shows a missing-fields state when the session has no machineId/workspaceId recorded yet", async () => {
    const html = await renderScreen(
      "sess-1",
      makeSnapshot([makeSession({ machineId: null, workspaceId: null })]),
    );
    expect(html).toContain("no machine/workspace recorded yet");
  });

  it("passes the session's real (plaintext) machineId/workspaceId through to the git panel, not a fabricated id", async () => {
    const html = await renderScreen(
      "sess-1",
      makeSnapshot([makeSession({ machineId: "mach-42", workspaceId: "/repo/work" })]),
    );
    expect(html).toContain("mach-42::/repo/work");
    // Guards against ever regressing back to the route's old fabricated
    // `mach-${id}` / `/workspace/${id}` placeholders (SessionGitScreen's own
    // doc comment describes replacing exactly that).
    expect(html).not.toContain("mach-sess-1");
    expect(html).not.toContain("/workspace/sess-1");
  });

  it("only renders the git panel once both machineId and workspaceId are present (partial data still counts as missing)", async () => {
    const html = await renderScreen(
      "sess-1",
      makeSnapshot([makeSession({ machineId: "mach-42", workspaceId: null })]),
    );
    expect(html).toContain("no machine/workspace recorded yet");
    expect(html).not.toContain("git-diff-panel");
  });
});
