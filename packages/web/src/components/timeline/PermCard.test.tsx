import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionControlProvider, useMockSessionControl } from "@/features/session-control";
import { extractPlanMarkdown, isExitPlanTool, PermCard } from "./PermCard";

/**
 * Covers the actual rendered placeholder text, not just that a lookup
 * function exists — this exact string regressed to a hardcoded "Claude"
 * once already (bug-fix-plan.md #2, fixed for the exit dialogs but missed
 * here), so the test needs to catch the real DOM output, not a helper.
 */
function renderPermCard(provider: string) {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SessionControlProvider
        sessionId="sess_1"
        useControl={useMockSessionControl}
        provider={provider}
      >
        <PermCard
          name="Bash"
          args={{ command: "ls" }}
          permission={{ reqId: "req_1", answerable: true, modes: [] }}
        />
      </SessionControlProvider>
    </QueryClientProvider>,
  );
}

describe("PermCard note placeholder — provider-aware copy", () => {
  it("names Codex for a codex session, not a hardcoded 'Claude'", () => {
    expect(renderPermCard("codex")).toContain("Optionally tell Codex what to do next");
  });

  it("names Claude Code for a claude-code session", () => {
    expect(renderPermCard("claude-code")).toContain("Optionally tell Claude Code what to do next");
  });
});

describe("isExitPlanTool", () => {
  it("matches Claude Code's PascalCase tool name", () => {
    expect(isExitPlanTool("ExitPlanMode")).toBe(true);
  });

  it("matches an ACP adapter's snake_case normalization", () => {
    expect(isExitPlanTool("exit_plan_mode")).toBe(true);
  });

  it("is false for any other tool", () => {
    expect(isExitPlanTool("Bash")).toBe(false);
  });
});

describe("extractPlanMarkdown (W2.2 — ExitPlanMode plan preview)", () => {
  it("returns the plan markdown for ExitPlanMode args", () => {
    expect(extractPlanMarkdown("ExitPlanMode", { plan: "# Step 1\nDo the thing" })).toBe(
      "# Step 1\nDo the thing",
    );
  });

  it("returns the plan markdown for the snake_case tool name too", () => {
    expect(extractPlanMarkdown("exit_plan_mode", { plan: "1. do it" })).toBe("1. do it");
  });

  it("returns null for a non-plan tool, even if args happen to have a 'plan' field", () => {
    expect(extractPlanMarkdown("Bash", { plan: "not a plan" })).toBeNull();
  });

  it("returns null when ExitPlanMode's args don't carry a string plan (adapter contract violation)", () => {
    expect(extractPlanMarkdown("ExitPlanMode", { plan: 42 })).toBeNull();
    expect(extractPlanMarkdown("ExitPlanMode", {})).toBeNull();
    expect(extractPlanMarkdown("ExitPlanMode", undefined)).toBeNull();
    expect(extractPlanMarkdown("ExitPlanMode", null)).toBeNull();
  });
});
