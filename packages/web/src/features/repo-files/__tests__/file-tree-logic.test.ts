import { describe, expect, it } from "vitest";
import { buildFileTree } from "../file-tree-logic";

describe("buildFileTree", () => {
  it("builds a single-level tree from flat top-level files", () => {
    const tree = buildFileTree(["b.ts", "a.ts"]);
    expect(tree).toEqual([
      { name: "a.ts", path: "a.ts", isDirectory: false },
      { name: "b.ts", path: "b.ts", isDirectory: false },
    ]);
  });

  it("nests files under their directory segments", () => {
    const tree = buildFileTree(["src/a.ts", "src/b.ts"]);
    expect(tree).toEqual([
      {
        name: "src",
        path: "src",
        isDirectory: true,
        children: [
          { name: "a.ts", path: "src/a.ts", isDirectory: false },
          { name: "b.ts", path: "src/b.ts", isDirectory: false },
        ],
      },
    ]);
  });

  it("shares a single directory node across multiple files in it", () => {
    const tree = buildFileTree(["src/a.ts", "src/b.ts", "src/nested/c.ts"]);
    expect(tree).toHaveLength(1);
    const srcNode = tree.at(0);
    expect(srcNode?.children).toHaveLength(3);
    const nested = srcNode?.children?.find((n) => n.name === "nested");
    expect(nested).toEqual({
      name: "nested",
      path: "src/nested",
      isDirectory: true,
      children: [{ name: "c.ts", path: "src/nested/c.ts", isDirectory: false }],
    });
  });

  it("sorts directories before files, alphabetically within each group", () => {
    const tree = buildFileTree(["z.ts", "src/a.ts", "a.ts", "lib/b.ts"]);
    expect(tree.map((n) => n.name)).toEqual(["lib", "src", "a.ts", "z.ts"]);
  });

  it("returns an empty tree for an empty file list", () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it("ignores blank segments from a leading/trailing slash", () => {
    const tree = buildFileTree(["/src/a.ts"]);
    expect(tree).toEqual([
      {
        name: "src",
        path: "src",
        isDirectory: true,
        children: [{ name: "a.ts", path: "src/a.ts", isDirectory: false }],
      },
    ]);
  });
});
