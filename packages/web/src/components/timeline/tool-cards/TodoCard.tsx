import { ListChecks } from "lucide-react";
import { parseTodoItems } from "@/lib/tool-args";
import { cn } from "@/lib/utils";
import type { ToolItem } from "@/sync/reducer";
import { ToolCardShell } from "./ToolCardShell";

export function TodoCard({ item }: { item: ToolItem }) {
  const todos = parseTodoItems(item.args);

  return (
    <ToolCardShell item={item} icon={<ListChecks className="size-4 text-muted-foreground" />}>
      {todos.length === 0 ? (
        <p className="text-xs text-muted-foreground">No todo items.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {todos.map((todo) => (
            <li
              key={`${todo.content ?? ""}:${todo.status ?? ""}`}
              className="flex items-start gap-2 text-sm"
            >
              <span
                className={cn(
                  "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
                  todo.status === "completed"
                    ? "border-emerald-500 bg-emerald-500/20"
                    : todo.status === "in_progress"
                      ? "border-amber-500 bg-amber-500/20"
                      : "border-muted-foreground/40",
                )}
              />
              <span
                className={cn(
                  todo.status === "completed" && "text-muted-foreground line-through",
                  todo.status === "in_progress" && "font-medium",
                )}
              >
                {todo.content ?? "(untitled)"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ToolCardShell>
  );
}
