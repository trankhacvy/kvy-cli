import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
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
      createElement(
        TooltipProvider,
        null,
        createElement(SessionListScreen, {
          useData: () => snapshot,
        }),
      ),
    ),
  );
}

describe("SessionListScreen (archived filter — docs/features/session-lifecycle-actions.md Phase 5)", () => {
  it("renders exactly the active session, excluding the archived one", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "falcon" }],
      machines: [{ id: "m1", name: "mac", online: true, status: "online" }],
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
      machines: [{ id: "m1", name: "mac", online: true, status: "online" }],
      sessions: [session({ id: "archived-sess", status: "archived" })],
    };

    const html = render(snapshot);
    expect(html).toContain("No sessions yet");
  });

  it("links to the Completed Chats screen", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "falcon" }],
      machines: [{ id: "m1", name: "mac", online: true, status: "online" }],
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
      machines: [{ id: "m1", name: "mac", online: true, status: "online" }],
      sessions: [
        session({ id: "a", workspaceId: "w1", status: "active" }),
        session({ id: "b", workspaceId: "w2", status: "archived" }),
      ],
    };

    const html = render(snapshot);
    expect(html).toContain("has-active");
    expect(html).not.toContain("all-archived");
  });

  // Feature 4 (docs/web-ux-improvements-plan.md): the "no sessions yet"
  // empty state now offers a real "New project" entry point rather than
  // only static CLI-pointing copy.
  it("renders the New project trigger in the zero-sessions empty state", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [],
      machines: [{ id: "m1", name: "mac", online: true, status: "online" }],
      sessions: [],
    };

    const html = render(snapshot);
    expect(html).toContain("No sessions yet");
    expect(html).toContain("New project");
  });

  it("still renders FirstMachineOnboarding, unchanged, for a zero-machine account", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [],
      machines: [],
      sessions: [],
    };

    const html = render(snapshot);
    expect(html).not.toContain("New project");
  });

  it("never renders the Unmanaged sessions section (hidden pending the duplicate-card fix)", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "falcon" }],
      machines: [{ id: "m1", name: "mac", online: true, status: "online" }],
      sessions: [session({ id: "active-sess", status: "active" })],
    };

    const html = render(snapshot);
    expect(html).not.toContain("Unmanaged sessions");
  });
});

describe("SessionListScreen (pagination)", () => {
  function sessionsAcross(workspaceId: string, count: number, startUpdatedAt: number) {
    return Array.from({ length: count }, (_, i) =>
      session({
        id: `${workspaceId}-${i}`,
        title: `${workspaceId} session ${i}`,
        workspaceId,
        updatedAt: startUpdatedAt - i,
      }),
    );
  }

  it("renders only the first page (10) and shows a Load more button when there are more", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "falcon" }],
      machines: [{ id: "m1", name: "mac", online: true, status: "online" }],
      sessions: sessionsAcross("w1", 12, 1000),
    };

    const html = render(snapshot);
    for (let i = 0; i < 10; i++) expect(html).toContain(`w1 session ${i}`);
    expect(html).not.toContain("w1 session 10");
    expect(html).not.toContain("w1 session 11");
    expect(html).toContain("Load 10 more");
  });

  it("doesn't show a Load more button when everything already fits on one page", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "falcon" }],
      machines: [{ id: "m1", name: "mac", online: true, status: "online" }],
      sessions: sessionsAcross("w1", 5, 1000),
    };

    const html = render(snapshot);
    expect(html).not.toContain("Load 10 more");
  });

  it("groups the top-N-by-recency slice by first appearance, not whole-group recency", () => {
    // "b" has the single most recent session (updatedAt 100), but "a" has
    // more sessions overall — with only 10 slots, the flat top-10 cut is
    // dominated by "a", and "b"'s one recent session must still surface
    // grouped in the order it actually appears in that cut.
    const snapshot: SessionListSnapshot = {
      workspaces: [
        { id: "a", name: "workspace-a" },
        { id: "b", name: "workspace-b" },
      ],
      machines: [{ id: "m1", name: "mac", online: true, status: "online" }],
      sessions: [
        session({ id: "b1", title: "b session", workspaceId: "b", updatedAt: 100 }),
        ...sessionsAcross("a", 9, 90),
      ],
    };

    const html = render(snapshot);
    const bIndex = html.indexOf("b session");
    const aIndex = html.indexOf("workspace-a");
    expect(bIndex).toBeGreaterThan(-1);
    expect(aIndex).toBeGreaterThan(-1);
    expect(bIndex).toBeLessThan(aIndex);
  });
});
