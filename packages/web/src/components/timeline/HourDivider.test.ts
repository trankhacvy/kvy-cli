import { describe, expect, it } from "vitest";
import { HourDivider } from "./HourDivider";

/** Purely presentational (`Timeline.tsx`, plan-v2.md W4.2 "hourly
 * dividers") — no hooks, so it can be called directly and its returned
 * element tree inspected without a render environment, same technique
 * `TimelineRow.test.ts`/`ToolCardShell.test.ts` use. */
describe("HourDivider", () => {
  it("renders the given label", () => {
    const el = HourDivider({ label: "Jul 18, 3:00 PM" });
    const children = el.props.children as unknown[];
    // [rule, label span, rule] — the label lives in the middle child.
    const labelSpan = children[1] as { props: { children: string } };
    expect(labelSpan.props.children).toBe("Jul 18, 3:00 PM");
  });
});
