import type { FileTreeNode } from "./types";

/**
 * Pure logic split out of `components/FileTree.tsx` so it's unit-testable
 * without a React component-testing setup — same rationale as
 * `features/new-session/components/directory-step-logic.ts`'s own doc
 * comment.
 *
 * `git.files` (`@kvy/wire`'s `GitFilesResult`) returns a flat array of
 * worktree-relative, posix-separated paths — this folds that into a nested
 * `FileTreeNode[]` the tree view can actually render, directories sorted
 * before files and both alphabetically within their own group (the
 * conventional file-explorer ordering).
 */
export function buildFileTree(files: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of files) {
    const segments = file.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;

    let level = root;
    let pathSoFar = "";
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string;
      pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
      const isLastSegment = i === segments.length - 1;

      let node = level.find((candidate) => candidate.name === segment);
      if (!node) {
        node = {
          name: segment,
          path: pathSoFar,
          isDirectory: !isLastSegment,
          ...(isLastSegment ? {} : { children: [] }),
        };
        level.push(node);
      }

      if (!isLastSegment) {
        // An intermediate segment is always a directory even if a
        // same-named leaf hasn't been seen yet — `git.files` never lists
        // directories themselves, so the only way a node gains `children`
        // is by being walked through here.
        node.isDirectory = true;
        node.children ??= [];
        level = node.children;
      }
    }
  }

  sortTree(root);
  return root;
}

function sortTree(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.children) sortTree(node.children);
  }
}
