/**
 * Ported verbatim from happy-cli/src/claude/utils/getToolDescriptor.ts (MIT),
 * fidelity (V) — plan.md §16 "2.3 Permission pipeline": "`getToolDescriptor`
 * port (read-only/edit/dangerous/exitPlan classification)".
 *
 * Classifies a Claude Code tool name for `PermissionHandler`'s auto-rules
 * (design §7.6): `edit` tools auto-approve in `acceptEdits` mode, `dangerous`
 * tools never auto-approve in `plan` mode, and `exitPlan` always requires a
 * prompt regardless of mode.
 */
export interface ToolDescriptor {
  edit: boolean;
  exitPlan: boolean;
  dangerous: boolean;
}

export function getToolDescriptor(toolName: string): ToolDescriptor {
  if (toolName === "exit_plan_mode" || toolName === "ExitPlanMode") {
    return { edit: false, exitPlan: true, dangerous: false };
  }
  if (toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write" || toolName === "NotebookEdit") {
    return { edit: true, exitPlan: false, dangerous: true };
  }
  if (toolName === "Bash") {
    return { edit: false, exitPlan: false, dangerous: true };
  }
  return { edit: false, exitPlan: false, dangerous: false };
}
