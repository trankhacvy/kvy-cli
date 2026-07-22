import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CompareAgainstSelect } from "./CompareAgainstSelect";

/**
 * The actual ref-picking behavior (sentinel mapping, "Custom…" reveal,
 * `-`-prefixed rejection) is proven directly, without rendering, by
 * `compare-against-select-state.test.ts` — Radix's `Select.Content` (like
 * `Dialog.Content`) only renders its item list while open, and this
 * package has no jsdom/`@testing-library/react` to click it open, so this
 * is a thin markup smoke-test only (same constraint as
 * `GitToolbar.test.tsx`).
 */
describe("CompareAgainstSelect", () => {
  it("renders the 'Compare against' label and a select trigger without calling onChange merely by mounting", () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(CompareAgainstSelect, { compareRef: null, onChange, branches: [] }),
    );
    expect(html).toContain("Compare against");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders without crashing when branches are present", () => {
    const html = renderToStaticMarkup(
      createElement(CompareAgainstSelect, {
        compareRef: "main",
        onChange: vi.fn(),
        branches: [
          { name: "main", isCurrent: true },
          { name: "wf/other", isCurrent: false },
        ],
      }),
    );
    expect(html).toContain("Compare against");
  });
});
