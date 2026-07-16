import type { ReactElement } from "react";
import type { ToolItem } from "@/sync/reducer";
import { BashCard } from "./BashCard";
import { EditCard } from "./EditCard";
import { GrepGlobCard } from "./GrepGlobCard";
import { McpGenericCard } from "./McpGenericCard";
import { ReadCard } from "./ReadCard";
import { TaskCard } from "./TaskCard";
import { TodoCard } from "./TodoCard";

/** ToolCard registry (falcon-system-design.md §9.2: "Bash, Edit+diff, Read,
 * Grep, Todo, Task/subagent group" — ported from Happy's `knownTools.tsx`
 * mapping, plan.md §8.4). Any tool name not listed here, plus every
 * `mcp__*` tool, falls back to `McpGenericCard`. */
const REGISTRY: Record<string, (item: ToolItem) => ReactElement> = {
  Bash: (item) => <BashCard item={item} />,
  Edit: (item) => <EditCard item={item} />,
  MultiEdit: (item) => <EditCard item={item} />,
  Write: (item) => <EditCard item={item} />,
  Read: (item) => <ReadCard item={item} />,
  Grep: (item) => <GrepGlobCard item={item} />,
  Glob: (item) => <GrepGlobCard item={item} />,
  TodoWrite: (item) => <TodoCard item={item} />,
  Task: (item) => <TaskCard item={item} />,
};

export function ToolCard({ item }: { item: ToolItem }) {
  if (item.name.startsWith("mcp__")) {
    return <McpGenericCard item={item} />;
  }

  const render = REGISTRY[item.name];
  return render ? render(item) : <McpGenericCard item={item} />;
}
