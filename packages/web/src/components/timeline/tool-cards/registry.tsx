import type { ReactElement } from "react";
import type { ToolItem } from "@/sync/reducer";
import { AskUserQuestionToolCard } from "./AskUserQuestionToolCard";
import { BashCard } from "./BashCard";
import { EditCard } from "./EditCard";
import { ExitPlanModeToolCard } from "./ExitPlanModeToolCard";
import { GrepGlobCard } from "./GrepGlobCard";
import { LsCard } from "./LsCard";
import { McpGenericCard } from "./McpGenericCard";
import { NotebookEditCard } from "./NotebookEditCard";
import { ReadCard } from "./ReadCard";
import { TaskCard } from "./TaskCard";
import { TodoCard } from "./TodoCard";
import { WebFetchCard } from "./WebFetchCard";
import { WebSearchCard } from "./WebSearchCard";

/** ToolCard registry (falcon-system-design.md §9.2: "Bash, Edit+diff, Read,
 * Grep, Todo, Task/subagent group" — ported from Happy's `knownTools.tsx`
 * mapping, plan.md §8.4). Any tool name not listed here, plus every
 * `mcp__*` tool, falls back to `McpGenericCard`. `AskUserQuestion` (plan-v2.md
 * W2.1) gets its own read-only card instead of that raw-JSON fallback.
 * `WebFetch`/`WebSearch`/`NotebookEdit`/`LS` (plan-v2.md W3.1) round out
 * coverage against Happy's own `knownTools.tsx` (19 native tools).
 * `ExitPlanMode`/`exit_plan_mode` (bug-fix-plan.md #6) get a dedicated card
 * instead of falling to the raw-JSON `McpGenericCard` fallback. */
const REGISTRY: Record<string, (item: ToolItem) => ReactElement> = {
  Bash: (item) => <BashCard item={item} />,
  Edit: (item) => <EditCard item={item} />,
  MultiEdit: (item) => <EditCard item={item} />,
  Write: (item) => <EditCard item={item} />,
  Read: (item) => <ReadCard item={item} />,
  Grep: (item) => <GrepGlobCard item={item} />,
  Glob: (item) => <GrepGlobCard item={item} />,
  LS: (item) => <LsCard item={item} />,
  TodoWrite: (item) => <TodoCard item={item} />,
  Task: (item) => <TaskCard item={item} />,
  AskUserQuestion: (item) => <AskUserQuestionToolCard item={item} />,
  ask_user_question: (item) => <AskUserQuestionToolCard item={item} />,
  WebFetch: (item) => <WebFetchCard item={item} />,
  WebSearch: (item) => <WebSearchCard item={item} />,
  NotebookEdit: (item) => <NotebookEditCard item={item} />,
  ExitPlanMode: (item) => <ExitPlanModeToolCard item={item} />,
  exit_plan_mode: (item) => <ExitPlanModeToolCard item={item} />,
};

export function ToolCard({ item }: { item: ToolItem }) {
  if (item.name.startsWith("mcp__")) {
    return <McpGenericCard item={item} />;
  }

  const render = REGISTRY[item.name];
  return render ? render(item) : <McpGenericCard item={item} />;
}
