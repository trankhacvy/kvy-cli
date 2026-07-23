import type { SessionRow } from "@falcon/wire";
import { QueryClient, QueryClientProvider, type UseMutationResult } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { syncQueryKey } from "@/sync/queryKeys";
import type { SyncSnapshot } from "@/sync/types";

// `getToken()` reads `window.localStorage`, which doesn't exist under this
// package's `environment: "node"` vitest config — mocked to a fixed token so
// the mutation's `mutationFn` gets past its own "Not signed in" guard,
// mirroring `OfflineBanner.test.ts`'s "mock the seam this hook can't get
// past under a DOM-less test run" precedent.
vi.mock("@/lib/session", () => ({ getToken: () => "tok-1" }));

const archiveSessionMock = vi.fn();
const deleteSessionMock = vi.fn();
const unarchiveSessionMock = vi.fn();
vi.mock("@/lib/api", () => ({
  archiveSession: (...args: unknown[]) => archiveSessionMock(...args),
  deleteSession: (...args: unknown[]) => deleteSessionMock(...args),
  unarchiveSession: (...args: unknown[]) => unarchiveSessionMock(...args),
}));

const { useArchiveSessionMutation, useDeleteSessionMutation, useRestoreSessionMutation } =
  await import("./use-session-lifecycle");

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

function seedSnapshot(queryClient: QueryClient, sessions: SessionRow[]): void {
  queryClient.setQueryData(syncQueryKey, {
    headerSeq: 1,
    sessions,
    machines: [],
    unmanagedSessions: [],
  } satisfies SyncSnapshot);
}

// Captures the mutation object a hook returns via a throwaway
// `renderToStaticMarkup` pass, then drives it directly — `mutate`/
// `mutateAsync` are plain closures backed by TanStack Query's own
// (React-independent) `MutationObserver`, so calling them after the
// static-markup render has already returned still exercises the real
// `onMutate`/`mutationFn`/`onError`/`onSuccess` pipeline without needing
// jsdom or `@testing-library/react`, neither of which this package wires up
// (see `use-session-title.test.ts`'s and `use-connectivity.test.ts`'s own
// "pre-effect frame" notes on why: those hooks only need the initial
// render, but nothing here needs an effect to fire in the first place —
// mutations are triggered by explicit calls, not effects).
function renderMutation<TVariables>(
  queryClient: QueryClient,
  useHook: () => UseMutationResult<unknown, Error, TVariables>,
): UseMutationResult<unknown, Error, TVariables> {
  let captured: UseMutationResult<unknown, Error, TVariables> | undefined;
  function Harness() {
    captured = useHook();
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
  if (!captured) throw new Error("Harness never rendered");
  return captured;
}

describe("useArchiveSessionMutation", () => {
  it("optimistically flips the session's status to archived before the request resolves", async () => {
    archiveSessionMock.mockReturnValue(new Promise(() => {})); // never resolves
    const queryClient = new QueryClient();
    seedSnapshot(queryClient, [makeSession({ id: "sess-1", status: "active" })]);
    const mutation = renderMutation(queryClient, useArchiveSessionMutation);

    mutation.mutate("sess-1");
    // onMutate runs synchronously before the (never-resolving) mutationFn awaits.
    await Promise.resolve();
    const snapshot = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
    expect(snapshot?.sessions[0]?.status).toBe("archived");
  });

  it("leaves other sessions in the snapshot untouched", async () => {
    archiveSessionMock.mockResolvedValue({ status: "archived" });
    const queryClient = new QueryClient();
    seedSnapshot(queryClient, [
      makeSession({ id: "sess-1", status: "active" }),
      makeSession({ id: "sess-2", status: "active" }),
    ]);
    const mutation = renderMutation(queryClient, useArchiveSessionMutation);

    await mutation.mutateAsync("sess-1");
    const snapshot = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
    expect(snapshot?.sessions.find((s) => s.id === "sess-2")?.status).toBe("active");
  });

  it("rolls back to the pre-mutation snapshot when the request fails", async () => {
    archiveSessionMock.mockRejectedValue(new Error("server exploded"));
    const queryClient = new QueryClient();
    seedSnapshot(queryClient, [makeSession({ id: "sess-1", status: "active" })]);
    const mutation = renderMutation(queryClient, useArchiveSessionMutation);

    await expect(mutation.mutateAsync("sess-1")).rejects.toThrow("server exploded");
    const snapshot = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
    expect(snapshot?.sessions[0]?.status).toBe("active");
  });

  it("passes the bearer token and sessionId through to archiveSession", async () => {
    archiveSessionMock.mockResolvedValue({ status: "archived" });
    const queryClient = new QueryClient();
    seedSnapshot(queryClient, [makeSession({ id: "sess-1" })]);
    const mutation = renderMutation(queryClient, useArchiveSessionMutation);

    await mutation.mutateAsync("sess-1");
    expect(archiveSessionMock).toHaveBeenCalledWith("tok-1", "sess-1");
  });
});

describe("useDeleteSessionMutation", () => {
  it("optimistically removes the session from the snapshot before the request resolves", async () => {
    deleteSessionMock.mockReturnValue(new Promise(() => {})); // never resolves
    const queryClient = new QueryClient();
    seedSnapshot(queryClient, [makeSession({ id: "sess-1" }), makeSession({ id: "sess-2" })]);
    const mutation = renderMutation(queryClient, useDeleteSessionMutation);

    mutation.mutate("sess-1");
    await Promise.resolve();
    const snapshot = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
    expect(snapshot?.sessions.map((s) => s.id)).toEqual(["sess-2"]);
  });

  it("restores the deleted row on rollback when the request fails", async () => {
    deleteSessionMock.mockRejectedValue(new Error("not found"));
    const queryClient = new QueryClient();
    seedSnapshot(queryClient, [makeSession({ id: "sess-1" })]);
    const mutation = renderMutation(queryClient, useDeleteSessionMutation);

    await expect(mutation.mutateAsync("sess-1")).rejects.toThrow("not found");
    const snapshot = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
    expect(snapshot?.sessions.map((s) => s.id)).toEqual(["sess-1"]);
  });

  it("is a no-op against the cache when no snapshot has been synced yet", async () => {
    deleteSessionMock.mockResolvedValue({});
    const queryClient = new QueryClient();
    const mutation = renderMutation(queryClient, useDeleteSessionMutation);

    await mutation.mutateAsync("sess-1");
    expect(queryClient.getQueryData(syncQueryKey)).toBeUndefined();
  });
});

describe("useRestoreSessionMutation", () => {
  it("optimistically flips the session's status back to active before the request resolves", async () => {
    unarchiveSessionMock.mockReturnValue(new Promise(() => {})); // never resolves
    const queryClient = new QueryClient();
    seedSnapshot(queryClient, [makeSession({ id: "sess-1", status: "archived" })]);
    const mutation = renderMutation(queryClient, useRestoreSessionMutation);

    mutation.mutate("sess-1");
    await Promise.resolve();
    const snapshot = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
    expect(snapshot?.sessions[0]?.status).toBe("active");
  });

  it("leaves other sessions in the snapshot untouched", async () => {
    unarchiveSessionMock.mockResolvedValue({ status: "active" });
    const queryClient = new QueryClient();
    seedSnapshot(queryClient, [
      makeSession({ id: "sess-1", status: "archived" }),
      makeSession({ id: "sess-2", status: "archived" }),
    ]);
    const mutation = renderMutation(queryClient, useRestoreSessionMutation);

    await mutation.mutateAsync("sess-1");
    const snapshot = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
    expect(snapshot?.sessions.find((s) => s.id === "sess-2")?.status).toBe("archived");
  });

  it("rolls back to the pre-mutation snapshot when the request fails", async () => {
    unarchiveSessionMock.mockRejectedValue(new Error("server exploded"));
    const queryClient = new QueryClient();
    seedSnapshot(queryClient, [makeSession({ id: "sess-1", status: "archived" })]);
    const mutation = renderMutation(queryClient, useRestoreSessionMutation);

    await expect(mutation.mutateAsync("sess-1")).rejects.toThrow("server exploded");
    const snapshot = queryClient.getQueryData<SyncSnapshot>(syncQueryKey);
    expect(snapshot?.sessions[0]?.status).toBe("archived");
  });

  it("passes the bearer token and sessionId through to unarchiveSession", async () => {
    unarchiveSessionMock.mockResolvedValue({ status: "active" });
    const queryClient = new QueryClient();
    seedSnapshot(queryClient, [makeSession({ id: "sess-1", status: "archived" })]);
    const mutation = renderMutation(queryClient, useRestoreSessionMutation);

    await mutation.mutateAsync("sess-1");
    expect(unarchiveSessionMock).toHaveBeenCalledWith("tok-1", "sess-1");
  });
});
