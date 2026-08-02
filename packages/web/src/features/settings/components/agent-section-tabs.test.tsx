import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentSection } from "./AgentSection";

vi.mock("@/features/new-session/favorites", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/new-session/favorites")>();
  return {
    ...actual,
    getFavoriteProvider: () => "claude-code",
    getFavoriteModel: () => "sonnet",
  };
});

describe("AgentSection", () => {
  it("renders one tab per provider, each with its icon", () => {
    const html = renderToStaticMarkup(createElement(AgentSection));
    expect(html).toContain("Claude Code");
    expect(html).toContain("Codex (beta)");
    expect((html.match(/<img/g) ?? []).length).toBe(2);
  });

  it("mounts only the active provider's pane (model select + helper)", () => {
    const html = renderToStaticMarkup(createElement(AgentSection));
    expect(html).toContain("agent-default-model-claude-code");
    expect(html).toContain("The model Claude Code sessions start with by default.");
    expect(html).not.toContain("agent-default-model-codex");
  });
});
