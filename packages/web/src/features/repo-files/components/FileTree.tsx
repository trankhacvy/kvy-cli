"use client";

import { ChevronRight, File as FileIcon, Folder, FolderOpen } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { FileTreeNode } from "../types";

/** One row's worth of indentation, in pixels — mirrors a conventional file-explorer tree's fixed-step nesting. */
const INDENT_PX = 14;

function TreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
  expanded,
  onToggle,
}: {
  node: FileTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}) {
  if (node.isDirectory) {
    const isExpanded = expanded.has(node.path);
    return (
      <li>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          aria-expanded={isExpanded}
          style={{ paddingLeft: `${depth * INDENT_PX + 4}px` }}
          className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-sm hover:bg-muted/60"
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              isExpanded && "rotate-90",
            )}
          />
          {isExpanded ? (
            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {isExpanded && node.children && node.children.length > 0 && (
          <ul>
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
                expanded={expanded}
                onToggle={onToggle}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        style={{ paddingLeft: `${depth * INDENT_PX + 22}px` }}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm hover:bg-muted/60",
          selectedPath === node.path && "bg-muted font-medium",
        )}
      >
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs">{node.name}</span>
      </button>
    </li>
  );
}

/**
 * The repo file tree (docs/competitive-notes-omnara.md #5 "Full repo file
 * browser"): a collapsible directory tree over `buildFileTree`'s nested
 * `FileTreeNode[]`, selecting a leaf calls `onSelect` with its
 * worktree-relative path. Expand/collapse state lives here (a plain
 * `Set<string>` of expanded directory paths) — the tree itself has no
 * server round-trip per expand, `git.files` already returned every path
 * up front.
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function onToggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  if (tree.length === 0) {
    return <p className="px-1 text-sm text-muted-foreground">No files found.</p>;
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          expanded={expanded}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}
