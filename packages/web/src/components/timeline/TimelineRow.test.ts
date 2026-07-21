import { describe, expect, it } from "vitest";
import type { RenderItem, UsageItem } from "@/sync/reducer";
import { ServiceLine } from "./ServiceLine";
import { TimelineRow } from "./TimelineRow";
import { UsageChip } from "./UsageChip";

/** `TimelineRow`'s dispatch by `kind` — calling it directly returns the
 * `React.createElement(...)` result (a plain object carrying `.type`), the
 * same DOM-free assertion pattern `tool-cards/registry.test.ts` uses for
 * `ToolCard`. */
describe("TimelineRow — usage dispatch (W4.6)", () => {
  it("routes a usage item to UsageChip", () => {
    const item: UsageItem = {
      id: "u1",
      time: 0,
      role: "agent",
      kind: "usage",
      inputTokens: 4,
      outputTokens: 5,
    };
    expect(TimelineRow({ item }).type).toBe(UsageChip);
  });

  it("routes a compact-boundary service marker to ServiceLine, same as any other service text", () => {
    const item: RenderItem = {
      id: "s1",
      time: 0,
      role: "agent",
      kind: "service",
      text: "History compacted (/clear)",
      quiet: false,
    };
    expect(TimelineRow({ item }).type).toBe(ServiceLine);
  });
});

describe("TimelineRow — permission-mode dispatch (docs/bug-fix-plan.md #5)", () => {
  it("routes a permission-mode item to ServiceLine with a mode+source label", () => {
    const item: RenderItem = {
      id: "pm1",
      time: 0,
      role: "agent",
      kind: "permission-mode",
      mode: "acceptEdits",
      source: "terminal",
    };
    const row = TimelineRow({ item });
    expect(row.type).toBe(ServiceLine);
    expect(row.props).toMatchObject({ label: "Permission mode: acceptEdits (terminal)" });
  });
});
