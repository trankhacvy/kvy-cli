import { Users } from "lucide-react";
import { asRecord, readString } from "@/lib/tool-args";
import type { ToolItem } from "@/sync/reducer";
import { ToolCardShell } from "./ToolCardShell";

/** `Task` spawns a subagent — the nested activity itself is rendered
 * generically by `ToolCardShell` (any tool call can carry a linked
 * `.subagent` scope), this just adds the prompt/description body. */
export function TaskCard({ item }: { item: ToolItem }) {
  const args = asRecord(item.args);
  const description = readString(args, "description");
  const prompt = readString(args, "prompt");

  return (
    <ToolCardShell item={item} icon={<Users className="size-4 text-muted-foreground" />}>
      {description && <p className="text-sm font-medium">{description}</p>}
      {prompt && <p className="mt-1 text-xs whitespace-pre-wrap text-muted-foreground">{prompt}</p>}
      {!item.subagent?.length && (
        <p className="mt-1 text-xs text-muted-foreground italic">
          {item.status === "running" ? "Subagent running…" : "No subagent activity recorded."}
        </p>
      )}
    </ToolCardShell>
  );
}
