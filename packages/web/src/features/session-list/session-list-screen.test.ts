import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useMockUnmanagedSessions } from "@/features/unmanaged-sessions";
import { SessionListScreen } from "./session-list-screen";
import type { SessionListSession, SessionListSnapshot } from "./types";

function session(overrides: Partial<SessionListSession>): SessionListSession {
  return {
    id: "s1",
    workspaceId: "w1",
    machineId: null,
    title: "session",
    provider: "claude",
    status: "active",
    updatedAt: 0,
    pinned: false,
    items: [],
    attention: null,
    ...overrides,
  };
}

function render(snapshot: SessionListSnapshot) {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SessionListScreen, {
        useData: () => snapshot,
        useUnmanagedSnapshot: () => ({ machines: [], sessions: [] }),
      }),
    ),
  );
}

describe("SessionListScreen (archived filter — docs/features/session-lifecycle-actions.md Phase 5)", () => {
  it("renders exactly the active session, excluding the archived one", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "falcon" }],
      machines: [],
      sessions: [
        session({ id: "active-sess", title: "Active session", status: "active" }),
        session({ id: "archived-sess", title: "Archived session", status: "archived" }),
      ],
    };

    const html = render(snapshot);
    expect(html).toContain("Active session");
    expect(html).not.toContain("Archived session");
  });

  it("falls through to the empty state when every session is archived", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "falcon" }],
      machines: [],
      sessions: [session({ id: "archived-sess", status: "archived" })],
    };

    const html = render(snapshot);
    expect(html).toContain("No sessions yet");
  });

  it("links to the Completed Chats screen", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "falcon" }],
      machines: [],
      sessions: [session({ id: "active-sess", status: "active" })],
    };

    const html = render(snapshot);
    expect(html).toContain("/completed");
    expect(html).toContain(">Completed<");
  });

  it("doesn't drop a workspace whose only sessions are all archived (no leaked empty group)", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [
        { id: "w1", name: "has-active" },
        { id: "w2", name: "all-archived" },
      ],
      machines: [],
      sessions: [
        session({ id: "a", workspaceId: "w1", status: "active" }),
        session({ id: "b", workspaceId: "w2", status: "archived" }),
      ],
    };

    const html = render(snapshot);
    expect(html).toContain("has-active");
    expect(html).not.toContain("all-archived");
  });

  it("still renders unmanaged sessions even with no managed data", () => {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(SessionListScreen, {
          useData: () => ({ workspaces: [], machines: [], sessions: [] }),
          useUnmanagedSnapshot: useMockUnmanagedSessions,
        }),
      ),
    );
    expect(html).not.toContain("No sessions yet");
  });
});
