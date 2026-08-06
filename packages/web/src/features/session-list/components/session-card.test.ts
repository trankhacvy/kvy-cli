import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionListSession } from "../types";
import { SessionCard } from "./session-card";

function session(overrides: Partial<SessionListSession> = {}): SessionListSession {
  return {
    id: "sess-1",
    workspaceId: null,
    path: null,
    machineId: null,
    title: "My session",
    provider: "claude",
    status: "active",
    updatedAt: 0,
    pinned: false,
    items: [],
    attention: null,
    ...overrides,
  };
}

function render(s: SessionListSession) {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SessionCard, { session: s, machine: null }),
    ),
  );
}

describe("SessionCard title (Issue #13 — no placeholder flash while decrypting)", () => {
  it("renders a Skeleton in place of the title while it hasn't decrypted yet (title: null)", () => {
    const html = render(session({ title: null }));

    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain("(untitled session)");
  });

  it("renders the real title as text once decrypted", () => {
    const html = render(session({ title: "My session" }));

    expect(html).toContain("My session");
    expect(html).not.toContain('data-slot="skeleton"');
  });
});
