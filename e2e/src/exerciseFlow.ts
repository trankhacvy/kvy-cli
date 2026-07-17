/**
 * Orchestrates the conformance harness (design §13 item 3): boots the real
 * local stack, runs the 20-step script in order, tears the stack down, and
 * returns a per-step report. Steps are dependent on each other's state
 * (step 2 needs step 1's sessionId, etc.) — a failing step stops the run
 * rather than pretending later steps are meaningful against broken state;
 * every step after the failure is reported `skipped`, not silently omitted.
 */

import { HarnessState, STEPS } from "./steps.js";
import { buildTestStack } from "./testStack.js";

export interface StepReport {
  name: string;
  status: "pass" | "fail" | "skipped";
  durationMs: number;
  error?: string;
}

export interface ExerciseFlowReport {
  steps: StepReport[];
  passed: number;
  failed: number;
  skipped: number;
}

export async function runExerciseFlow(): Promise<ExerciseFlowReport> {
  const stack = await buildTestStack();
  const state = new HarnessState(stack);
  const steps: StepReport[] = [];
  let stopped = false;

  try {
    for (const step of STEPS) {
      if (stopped) {
        steps.push({ name: step.name, status: "skipped", durationMs: 0 });
        continue;
      }
      const startedAt = Date.now();
      try {
        await step.run(state);
        steps.push({ name: step.name, status: "pass", durationMs: Date.now() - startedAt });
      } catch (error) {
        steps.push({
          name: step.name,
          status: "fail",
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        stopped = true;
      }
    }
  } finally {
    await stack.teardown();
  }

  return {
    steps,
    passed: steps.filter((s) => s.status === "pass").length,
    failed: steps.filter((s) => s.status === "fail").length,
    skipped: steps.filter((s) => s.status === "skipped").length,
  };
}
