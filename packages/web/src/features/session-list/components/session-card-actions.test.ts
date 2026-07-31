import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionCardActions } from "./session-card-actions";
import {
  buildPinTogglePatch,
  canOfferRemoveWorktree,
  isSessionStoppable,
} from "./session-card-actions-logic";

function render(props: Partial<Parameters<typeof SessionCardActions>[0]> = {}) {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SessionCardActions, {
        sessionId: "sess-1",
        title: "My session",
        pinned: false,
        status: "active",
        machineId: null,
        workspaceId: null,
        ...props,
      }),
    ),
  );
}

describe("SessionCardActions", () => {
  it("renders a single accessible '···' trigger button, enabled before any mutation fires", () => {
    const html = render();
    expect(html).toContain('aria-label="Session actions"');
    // Same "disabled:" Tailwind-variant-vs-boolean-attribute distinction as
    // `SessionHeaderActions.test.ts` — check the real HTML attribute, not a
    // substring that's always present in the static className.
    expect(html).not.toContain('disabled=""');
  });

  it("does not render the rename dialog's content until it's opened", () => {
    const html = render();
    expect(html).not.toContain("Rename session");
  });

  it("does not render the archive dialog's content until it's opened", () => {
    const html = render();
    expect(html).not.toContain('Archive "');
  });

  it("renders without throwing for a title containing characters that would matter if this were ever built via string concatenation instead of JSX interpolation", () => {
    expect(() => render({ title: 'Session "with quotes"' })).not.toThrow();
  });

  it("renders without throwing across every session status", () => {
    const statuses = ["active", "archived", "failed", "compacted", "ended"] as const;
    for (const status of statuses) {
      expect(() => render({ status })).not.toThrow();
    }
  });

  it("renders without throwing whether pinned or not", () => {
    expect(() => render({ pinned: true })).not.toThrow();
    expect(() => render({ pinned: false })).not.toThrow();
  });

  it("renders without throwing for every worktree/machine combination", () => {
    expect(() => render({ machineId: "m1", workspaceId: "/repo" })).not.toThrow();
    expect(() => render({ machineId: null, workspaceId: "/repo/.worktrees/wf/foo" })).not.toThrow();
    expect(() => render({ machineId: "m1", workspaceId: "/repo/.worktrees/wf/foo" })).not.toThrow();
  });
});

describe("canOfferRemoveWorktree", () => {
  it("is true only when both a machine and a .worktrees-shaped workspaceId are present", () => {
    expect(canOfferRemoveWorktree("m1", "/repo/.worktrees/wf/foo")).toBe(true);
  });

  it("is false for a repo-root workspaceId even with a known machine", () => {
    expect(canOfferRemoveWorktree("m1", "/repo")).toBe(false);
  });

  it("is false with no owning machine even for a .worktrees path", () => {
    expect(canOfferRemoveWorktree(null, "/repo/.worktrees/wf/foo")).toBe(false);
  });

  it("is false for a null workspaceId", () => {
    expect(canOfferRemoveWorktree("m1", null)).toBe(false);
  });
});

describe("SessionCardActions menu swap by status (archived rows drop Archive)", () => {
  it("renders without throwing for every combination of status and pinned", () => {
    const statuses = ["active", "archived", "failed", "compacted", "ended"] as const;
    for (const status of statuses) {
      for (const pinned of [true, false]) {
        expect(() => render({ status, pinned })).not.toThrow();
      }
    }
  });
});

describe("isSessionStoppable (gates whether Archive attempts a stop RPC first)", () => {
  it("is stoppable while active", () => {
    expect(isSessionStoppable("active")).toBe(true);
  });

  it("is stoppable while compacted (still a live process, just mid-compaction)", () => {
    expect(isSessionStoppable("compacted")).toBe(true);
  });

  it("is not stoppable once ended", () => {
    expect(isSessionStoppable("ended")).toBe(false);
  });

  it("is not stoppable once failed", () => {
    expect(isSessionStoppable("failed")).toBe(false);
  });

  it("is not stoppable once archived", () => {
    expect(isSessionStoppable("archived")).toBe(false);
  });
});

describe("buildPinTogglePatch", () => {
  it("flips pinned true -> false while preserving every other key", () => {
    const patch = buildPinTogglePatch(true);
    expect(patch({ title: "t", model: "opus", pinned: true })).toEqual({
      title: "t",
      model: "opus",
      pinned: false,
    });
  });

  it("flips pinned false -> true while preserving every other key", () => {
    const patch = buildPinTogglePatch(false);
    expect(patch({ title: "t", path: "/work" })).toEqual({
      title: "t",
      path: "/work",
      pinned: true,
    });
  });
});
