import { Badge } from "@/components/ui/badge";
import type { GitFileStatus } from "../types";

const LABEL: Record<GitFileStatus["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

const VARIANT: Record<GitFileStatus["status"], "success" | "warning" | "destructive" | "outline"> = {
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
