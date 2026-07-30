import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GitDiffContent } from "../types";
import { UnifiedDiffViewer } from "./UnifiedDiffViewer";

const RAW_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " unchanged",
  "-removed line",
  "+added line",
  " tail",
  "",
].join("\n");

function content(overrides: Partial<GitDiffContent> = {}): GitDiffContent {
  return { inline: RAW_DIFF, truncated: false, ...overrides };
}

/**
 * `@git-diff-view/react`'s `DiffView` renders through `react-dom/server`
 * fine (its own readme advertises SSR support) — this smoke-tests that it
 * mounts under this package's jsdom-less `renderToStaticMarkup` harness
 * without throwing, and that the surrounding chrome (truncation notice,
 * empty states) still renders as before the Phase 4 swap.
 */
describe("UnifiedDiffViewer", () => {
  it("renders 'No differences.' for an empty diff", () => {
    const html = renderToStaticMarkup(
      createElement(UnifiedDiffViewer, { diff: content({ inline: "" }) }),
    );
    expect(html).toContain("No differences.");
  });

  it("renders 'No differences.' when inline is undefined", () => {
    const html = renderToStaticMarkup(
      createElement(UnifiedDiffViewer, { diff: content({ inline: undefined }) }),
    );
    expect(html).toContain("No differences.");
  });

  it("renders the file path header for a real diff, without throwing", () => {
    const html = renderToStaticMarkup(createElement(UnifiedDiffViewer, { diff: content() }));
    expect(html).toContain("src/a.ts");
  });

  it("renders the truncation notice, without a 'view file' button when onNarrowToFile is omitted", () => {
    const html = renderToStaticMarkup(
      createElement(UnifiedDiffViewer, { diff: content({ truncated: true }) }),
    );
    expect(html).toContain("truncated");
    expect(html).not.toContain("View src/a.ts");
  });

  it("renders a 'View <file>' button wired to onNarrowToFile when the diff is truncated", () => {
    const onNarrowToFile = vi.fn();
    const html = renderToStaticMarkup(
      createElement(UnifiedDiffViewer, { diff: content({ truncated: true }), onNarrowToFile }),
    );
    expect(html).toContain("View src/a.ts");
    expect(onNarrowToFile).not.toHaveBeenCalled();
  });

  it("does not render the truncation notice for an untruncated diff", () => {
    const html = renderToStaticMarkup(createElement(UnifiedDiffViewer, { diff: content() }));
    expect(html).not.toContain("truncated");
  });

  it("renders 'Binary file — no diff to show.' for a binary file, without invoking DiffView", () => {
    const binaryDiff = [
      "diff --git a/img.png b/img.png",
      "index 1111111..2222222 100644",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n");
    const html = renderToStaticMarkup(
      createElement(UnifiedDiffViewer, { diff: content({ inline: binaryDiff }) }),
    );
    expect(html).toContain("Binary file");
  });
});
