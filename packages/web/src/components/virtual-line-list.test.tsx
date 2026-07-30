import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VirtualLineList } from "./virtual-line-list";

/**
 * `@tanstack/react-virtual` measures its scroll container via a real DOM
 * `ResizeObserver`/`getBoundingClientRect` — under `renderToStaticMarkup`
 * (this package has no jsdom) the scroll element's measured size is zero,
 * so the virtualizer only ever renders a handful of rows near the top
 * (whatever fits an unmeasured zero-height viewport plus overscan), never
 * the full `count`. That's a real environment limitation, not a bug in the
 * component — so this only asserts what's meaningful without real layout:
 * the total-height math (`count * rowHeight`, independent of what's
 * actually painted) and that `renderRow` is never called with an
 * out-of-range index.
 */
describe("VirtualLineList", () => {
  it("computes a total scroll height of count * rowHeight, exposed via the wrapper's style", () => {
    const renderRow = vi.fn(() => null);
    const html = renderToStaticMarkup(
      createElement(VirtualLineList, { count: 500, rowHeight: 20, renderRow }),
    );
    expect(html).toContain('style="height:10000px;position:relative"');
  });

  it("never calls renderRow with an index outside [0, count)", () => {
    const renderRow = vi.fn((_index: number) => null);
    renderToStaticMarkup(createElement(VirtualLineList, { count: 50, rowHeight: 20, renderRow }));
    for (const [index] of renderRow.mock.calls) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(50);
    }
  });

  it("renders an empty scroll area (zero height) for count: 0", () => {
    const renderRow = vi.fn(() => null);
    const html = renderToStaticMarkup(
      createElement(VirtualLineList, { count: 0, rowHeight: 20, renderRow }),
    );
    expect(html).toContain('style="height:0px;position:relative"');
    expect(renderRow).not.toHaveBeenCalled();
  });
});
