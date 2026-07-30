"use client";

import { ChevronRight, File as FileIcon, Folder, FolderOpen } from "lucide-react";
import type { NodeRendererProps } from "react-arborist";
import { Tree } from "react-arborist";
import { useElementSize } from "@/hooks/use-element-size";
import { cn } from "@/lib/utils";
import type { FileTreeNode } from "../types";

const ROW_HEIGHT = 28;
const MIN_HEIGHT = 200;

function paddingLeftPx(style: React.CSSProperties, extra: number): string {
  const base = typeof style.paddingLeft === "number" ? style.paddingLeft : 0;
  return `${base + extra}px`;
}

function Node({
  node,
  style,
  selectedPath,
  onSelect,
}: NodeRendererProps<FileTreeNode> & {
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  if (node.data.isDirectory) {
    return (
      <button
        type="button"
        onClick={() => node.toggle()}
        aria-expanded={node.isOpen}
        style={{ ...style, paddingLeft: paddingLeftPx(style, 4) }}
        className="flex h-full w-full items-center gap-1 rounded-md pr-2 text-left text-sm hover:bg-muted/60"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            node.isOpen && "rotate-90",
          )}
        />
        {node.isOpen ? (
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{node.data.name}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(node.data.path)}
      style={{ ...style, paddingLeft: paddingLeftPx(style, 22) }}
      className={cn(
        "flex h-full w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm hover:bg-muted/60",
        selectedPath === node.data.path && "bg-muted font-medium",
      )}
    >
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-xs">{node.data.name}</span>
    </button>
  );
}

/**
 * The repo file tree (docs/competitive-notes-omnara.md #5 "Full repo file
 * browser"): a collapsible, virtualized directory tree over
 * `buildFileTree`'s nested `FileTreeNode[]`, selecting a leaf calls
 * `onSelect` with its worktree-relative path.
 *
 * Feature 3 Phase 3 (docs/web-ux-improvements-plan.md): replaces the old
 * hand-rolled recursive `<TreeNode>` (a plain `<ul>`/`<li>` walk with no
 * windowing) with `react-arborist`'s `<Tree>` — purpose-built windowing,
 * keyboard nav, and selection out of the box. `buildFileTree`'s output shape
 * (`name`/`path`/`isDirectory`/`children?`) already matches what
 * `idAccessor="path"` needs, so `file-tree-logic.ts` and its tests are
 * untouched — only the renderer changed. Expand/collapse state now lives
 * inside `react-arborist`'s own internal store instead of a `Set<string>`
 * this component used to own directly.
 *
 * `react-arborist` has no built-in auto-sizer (unlike
 * `@tanstack/react-virtual`'s scroll-element-driven approach) — it needs
 * explicit pixel `width`/`height`, measured here via `useElementSize`.
 * Drag/drop/rename/create are all explicitly disabled: this tree is
 * read-only browsing, not a file manager.
 */
export function FileTree({
  tree,
  selectedPath,
  onSelect,
}: {
  tree: FileTreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [containerRef, size] = useElementSize<HTMLDivElement>();

  if (tree.length === 0) {
    return <p className="px-1 text-sm text-muted-foreground">No files found.</p>;
  }

  return (
    <div ref={containerRef} className="h-full min-h-[200px] w-full">
      <Tree<FileTreeNode>
        data={tree}
        idAccessor="path"
        openByDefault={false}
        rowHeight={ROW_HEIGHT}
        indent={14}
        width={size.width || undefined}
        height={size.height || MIN_HEIGHT}
        disableDrag
        disableDrop
        disableEdit
      >
        {(props) => <Node {...props} selectedPath={selectedPath} onSelect={onSelect} />}
      </Tree>
    </div>
  );
}
