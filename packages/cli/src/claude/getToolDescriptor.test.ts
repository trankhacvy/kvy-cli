import { describe, expect, it } from "vitest";
import { getToolDescriptor } from "./getToolDescriptor.js";

describe("getToolDescriptor", () => {
  it("classifies ExitPlanMode (both spellings) as exitPlan, nothing else", () => {
    expect(getToolDescriptor("ExitPlanMode")).toEqual({ edit: false, exitPlan: true, dangerous: false });
    expect(getToolDescriptor("exit_plan_mode")).toEqual({ edit: false, exitPlan: true, dangerous: false });
  });

  it("classifies edit tools as edit+dangerous, not exitPlan", () => {
    for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit"]) {
      expect(getToolDescriptor(tool)).toEqual({ edit: true, exitPlan: false, dangerous: true });
    }
  });

  it("classifies Bash as dangerous only", () => {
    expect(getToolDescriptor("Bash")).toEqual({ edit: false, exitPlan: false, dangerous: true });
  });

  it("classifies unknown/read-only tools as neither edit, exitPlan, nor dangerous", () => {
    for (const tool of ["Read", "Glob", "Grep", "AskUserQuestion", "SomeMcpTool"]) {
      expect(getToolDescriptor(tool)).toEqual({ edit: false, exitPlan: false, dangerous: false });
    }
  });
});
