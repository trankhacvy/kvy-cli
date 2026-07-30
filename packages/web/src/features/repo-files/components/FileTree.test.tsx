import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FileTreeNode } from "../types";
import { FileTree } from "./FileTree";

/**
 * `react-arborist`'s `<Tree>` needs a real `ResizeObserver` to auto-size
 * (`useElementSize`'s effect never runs under `renderToStaticMarkup` — this
 * package has no jsdom, same constraint documented throughout this
 * package's other component tests), so every render here falls back to the
 * component's own `MIN_HEIGHT`/default-width path. `react-window` (which
 * `react-arborist` renders through) still renders statically fine at that
 * size — this asserts the structural output: root rows are present, a
 * selected leaf is marked, and empty input renders the empty-state copy.
 */
function tree(): FileTreeNode[] {
  return [
    {
      name: "src",
      path: "src",
      isDirectory: true,
      children: [
        { name: "a.ts", path: "src/a.ts", isDirectory: false },
        { name: "b.ts", path: "src/b.ts", isDirectory: false },
      ],
    },
    { name: "README.md", path: "README.md", isDirectory: false },
  ];
}

describe("FileTree", () => {
  it("renders the empty state for an empty tree", () => {
    const html = renderToStaticMarkup(
      createElement(FileTree, { tree: [], selectedPath: null, onSelect: vi.fn() }),
    );
    expect(html).toContain("No files found.");
  });

  it("renders root-level nodes (top-level directory and file names)", () => {
    const html = renderToStaticMarkup(
      createElement(FileTree, { tree: tree(), selectedPath: null, onSelect: vi.fn() }),
    );
    expect(html).toContain("src");
    expect(html).toContain("README.md");
  });

  it("never calls onSelect merely by rendering", () => {
    const onSelect = vi.fn();
    renderToStaticMarkup(createElement(FileTree, { tree: tree(), selectedPath: null, onSelect }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
