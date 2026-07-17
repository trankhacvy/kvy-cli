/**
 * `pnpm --filter @falcon/e2e exercise-flow` — the human/CI-facing entry
 * point for the release-gate script (plan.md §16 "4.4 Hardening & release
 * gate": "run pre-release"). Prints a PASS/FAIL line per step and exits
 * non-zero on any failure, so it composes as a CI gate or a local
 * pre-release check without any extra parsing.
 */
import { runExerciseFlow } from "./exerciseFlow.js";

const ICONS: Record<string, string> = { pass: "✓", fail: "✗", skipped: "-" };

async function main(): Promise<void> {
  const lines: string[] = ["falcon exercise-flow — 20-step conformance harness", ""];

  const report = await runExerciseFlow();

  for (const step of report.steps) {
    const icon = ICONS[step.status] ?? "?";
    const timing = step.status === "skipped" ? "" : ` (${step.durationMs}ms)`;
    lines.push(`  ${icon} ${step.name}${timing}`);
    if (step.error) lines.push(`      ${step.error}`);
  }

  lines.push(
    "",
    `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped (of ${report.steps.length})`,
    "",
  );

  process.stdout.write(lines.join("\n"));
  process.exit(report.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`exercise-flow: fatal error outside the step loop: ${String(error)}\n`);
  process.exit(1);
});
