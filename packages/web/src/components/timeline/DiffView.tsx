import { diffLines } from "@/lib/diff";
import { cn } from "@/lib/utils";

/** Inline unified-style line diff for `Edit`/`Write`/`MultiEdit` tool cards
 * (falcon-system-design.md §9.2 "diffs via ... a custom unified renderer"). */
export function DiffView({ oldText, newText }: { oldText?: string; newText?: string }) {
  if (oldText === undefined && newText === undefined) {
    return <p className="text-xs text-muted-foreground">(no change content captured)</p>;
  }

  const lines = diffLines(oldText ?? "", newText ?? "");

  return (
    <pre className="overflow-x-auto rounded-md border border-border/70 bg-muted/30 py-1 font-mono text-xs">
      <code>
        {lines.map((line, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and frequently repeat content (e.g. blank context lines) — the list is static per render, derived purely from oldText/newText props, so index is the correct identity here.
            key={`${index}:${line.type}`}
            className={cn(
              "px-2.5 py-0.5 whitespace-pre-wrap",
              line.type === "add" && "bg-emerald-500/15 text-emerald-400",
              line.type === "remove" && "bg-red-500/15 text-red-400",
            )}
          >
            <span className="mr-2 text-muted-foreground/60 select-none">
              {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
            </span>
            {line.text}
          </div>
        ))}
      </code>
    </pre>
  );
}
