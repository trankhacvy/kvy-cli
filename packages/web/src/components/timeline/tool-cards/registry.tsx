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
import { TaskEntryCard } from "./TaskEntryCard";
import { TodoCard } from "./TodoCard";
import { WebFetchCard } from "./WebFetchCard";
import { WebSearchCard } from "./WebSearchCard";

/** ToolCard registry: maps tool names to their card components. Any tool name not listed
 * here, plus every `mcp__*` tool, falls back to `McpGenericCard`. */
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
  TaskCreate: (item) => <TaskEntryCard item={item} />,
  TaskUpdate: (item) => <TaskEntryCard item={item} />,
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
