import { Badge } from "@/components/ui/badge";
import type { GitFileStatus } from "../types";

const LABEL: Record<GitFileStatus["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

const VARIANT: Record<GitFileStatus["status"], "success" | "warning" | "destructive" | "outline"> =
  {
    added: "success",
    modified: "warning",
    deleted: "destructive",
    renamed: "outline",
    untracked: "outline",
  };

/** One-letter status chip (A/M/D/R/U), matching `git status`'s own porcelain letters — familiar to anyone who's used git. */
export function FileStatusBadge({ status }: { status: GitFileStatus["status"] }) {
  return (
    <Badge variant={VARIANT[status]} className="w-5 justify-center px-0 font-mono">
      {LABEL[status]}
    </Badge>
  );
}

/**
 * `+12 -3`-style line-count stat (`git diff --numstat`, `daemon/gitStatus.ts`)
 * — `undefined` for an untracked file (never diffed) or a binary file (git
 * reports `-`/`-` there, not a real count), in which case this renders
 * nothing rather than a misleading `+0 -0`. Zero-only sides are omitted too
 * (a pure deletion shows just `-3`, not `+0 -3`).
 */
export function FileStatChange({
  insertions,
  deletions,
}: {
  insertions?: number;
  deletions?: number;
}) {
  if (insertions === undefined && deletions === undefined) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums">
      {Boolean(insertions) && <span className="text-emerald-500">+{insertions}</span>}
      {Boolean(deletions) && <span className="text-destructive">-{deletions}</span>}
    </span>
  );
}
