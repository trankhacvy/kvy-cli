/**
 * Wires the conformance harness into `pnpm test` (turbo's default CI
 * pipeline) so a regression in any of the 20 steps fails CI, not just a
 * pre-release run someone remembered to trigger by hand.
 */
import { describe, expect, it } from "vitest";
import { runExerciseFlow } from "./exerciseFlow.js";

describe("exercise-flow (design §13 item 3: 20-step conformance harness)", () => {
  it("runs all 20 steps against a real local stack without a failure", async () => {
    const report = await runExerciseFlow();

    if (report.failed > 0) {
      const failures = report.steps
        .filter((s) => s.status === "fail")
        .map((s) => `  - ${s.name}: ${s.error}`)
        .join("\n");
      throw new Error(`exercise-flow: ${report.failed} step(s) failed:\n${failures}`);
    }

    expect(report.steps).toHaveLength(20);
    expect(report.passed).toBe(20);
    expect(report.skipped).toBe(0);
  });
});
