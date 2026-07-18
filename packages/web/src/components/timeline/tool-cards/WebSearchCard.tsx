import { Radar } from "lucide-react";
import { parseWebSearchArgs, parseWebSearchResults } from "@/lib/tool-args";
import type { ToolItem } from "@/sync/reducer";
import { JsonBlock } from "../JsonBlock";
import { ToolCardShell } from "./ToolCardShell";

/** `WebSearch`: query + a result-link list, parsed out of Claude Code's
 * plain-text tool-result blob (`parseWebSearchResults` — verified against a
 * real transcript). Falls back to a raw `JsonBlock` dump when the embedded
 * `Links: [...]` array isn't found (design principle: unknown shapes are
 * shown, never hidden). */
export function WebSearchCard({ item }: { item: ToolItem }) {
  const args = parseWebSearchArgs(item.args);
  const results = parseWebSearchResults(item.output);

  return (
    <ToolCardShell item={item} icon={<Radar className="size-4 text-muted-foreground" />}>
      <p className="truncate text-xs text-muted-foreground">
        {args.query ?? "(no query captured)"}
      </p>
      {results ? (
        <ul className="mt-1.5 flex flex-col gap-1">
          {results.map((r) => (
            <li key={`${r.url ?? ""}::${r.title ?? ""}`} className="truncate text-xs">
              {r.url ? (
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline-offset-2 hover:underline"
                >
                  {r.title ?? r.url}
                </a>
              ) : (
                <span>{r.title}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        item.output !== undefined && <JsonBlock value={item.output} className="mt-1.5" />
      )}
    </ToolCardShell>
  );
}
