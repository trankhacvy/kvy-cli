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

/**
 * Renders a long filesystem path truncated in the middle rather than at the
 * end, so the folder/file name (the part a user actually looks for) always
 * stays fully visible — the ellipsis eats into the head instead. Pure CSS
 * (flex + `truncate` on the head, `shrink-0` on the tail), no width
 * measurement needed: the head shrinks to fit whatever space is left after
 * the tail claims its natural width. `className` styles the outer box
 * (border/background/padding/font — same box a plain truncated `<p>` would
 * have had); the full path is always available via the native `title`
 * tooltip.
 */
export function TruncatedPath({ path, className }: { path: string; className?: string }) {
  const { head, tail } = splitPathTail(path);
  return (
    <div className={cn("flex min-w-0 items-center", className)} title={path}>
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0 whitespace-nowrap">{tail}</span>
    </div>
  );
}
