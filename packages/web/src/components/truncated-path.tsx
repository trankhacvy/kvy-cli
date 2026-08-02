import { cn } from "@/lib/utils";

/**
 * Splits `path` into everything up to (and including) the last separator
 * and the final segment (the folder/file name) — the piece a user most
 * wants to keep visible when a long path has to be truncated. Handles both
 * `/` and `\` separators, same convention as `WorkingDirectoryChip.tsx`'s
 * `workingDirectoryBasename`. A trailing slash is stripped first so
 * `"/a/b/"` still yields `tail: "b"`, not an empty string.
 */
export function splitPathTail(path: string): { head: string; tail: string } {
  const trimmed = path.replace(/[/\\]+$/, "");
  const match = /^(.*[/\\])([^/\\]+)$/.exec(trimmed);
  if (!match) return { head: "", tail: path };
  const [, head, tail] = match;
  return { head: head ?? "", tail: tail ?? path };
}

export function TruncatedPath({ path, className }: { path: string; className?: string }) {
  const { head, tail } = splitPathTail(path);
  return (
    <div className={cn("flex min-w-0 items-center", className)} title={path}>
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0 whitespace-nowrap">{tail}</span>
    </div>
  );
}
