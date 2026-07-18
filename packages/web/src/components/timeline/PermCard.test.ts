import { describe, expect, it } from "vitest";
import { extractPlanMarkdown, isExitPlanTool } from "./PermCard";

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
