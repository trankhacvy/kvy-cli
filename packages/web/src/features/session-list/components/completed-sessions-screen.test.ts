import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionListSession, SessionListSnapshot } from "../types";
import { CompletedSessionsScreen } from "./completed-sessions-screen";

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
        createElement(CompletedSessionsScreen, { useData: () => snapshot }),
      ),
    ),
  );
}

describe("CompletedSessionsScreen (docs/features/session-lifecycle-actions.md Phase 5)", () => {
  it("renders exactly the archived session, excluding the active one", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "kvy" }],
      machines: [],
      sessions: [
        session({ id: "active-sess", title: "Active session", status: "active" }),
        session({ id: "archived-sess", title: "Archived session", status: "archived" }),
      ],
    };

    const html = render(snapshot);
    expect(html).toContain("Archived session");
    expect(html).not.toContain("Active session");
  });

  it("shows the empty state when nothing is archived", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "kvy" }],
      machines: [],
      sessions: [session({ id: "active-sess", status: "active" })],
    };

    const html = render(snapshot);
    expect(html).toContain("Nothing completed yet");
  });

  it("renders the heading and a link back to Home", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "kvy" }],
      machines: [],
      sessions: [session({ id: "archived-sess", status: "archived" })],
    };

    const html = render(snapshot);
    expect(html).toContain("Completed Chats");
    expect(html).toContain("Back to Home");
  });

  it("never renders a 'New session' CTA", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "kvy" }],
      machines: [],
      sessions: [session({ id: "archived-sess", status: "archived" })],
    };

    const html = render(snapshot);
    expect(html).not.toContain("New session");
  });
});
