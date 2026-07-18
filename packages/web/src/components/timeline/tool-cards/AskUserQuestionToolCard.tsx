import { HelpCircle } from "lucide-react";
import { parseAskAnswers, parseAskQuestions } from "@/lib/tool-args";
import type { ToolItem } from "@/sync/reducer";
import { JsonBlock } from "../JsonBlock";
import { ToolCardShell } from "./ToolCardShell";

/**
 * Read-only `AskUserQuestion` ToolCard (plan-v2.md W2.1) — replaces
 * `McpGenericCard`'s raw-JSON fallback for a locally-answered question (the
 * terminal widget rendered, the human answered it there, and the tailer
 * mirrored question+answer as an ordinary tool-start/tool-end pair; a
 * still-pending web-turn question is handled separately by
 * `ToolCardShell`'s own `AskUserQuestionCard` dispatch, so this body stays
 * out of the way while `item.permission` is undecided). Falls back to a raw
 * `JsonBlock` of the tool-end output when it isn't one of the two answer
 * shapes `parseAskAnswers` recognizes (design principle: unknown shapes are
 * shown, never hidden).
 */
export function AskUserQuestionToolCard({ item }: { item: ToolItem }) {
  const questions = parseAskQuestions(item.args);
  const answers = parseAskAnswers(item.output);
  const pending = item.permission !== undefined && item.permission.decision === undefined;

  return (
    <ToolCardShell item={item} icon={<HelpCircle className="size-4 text-muted-foreground" />}>
      {pending ? (
        <p className="text-xs text-muted-foreground">Waiting for an answer…</p>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          {questions.map((q) => {
            const answer = answers?.find((a) => a.question === q.question)?.answer;
            return (
              <div key={q.question} className="flex flex-col gap-0.5">
                <p className="font-medium">{q.question}</p>
                <p className="text-muted-foreground">{answer ?? "(no answer recorded)"}</p>
              </div>
            );
          })}
          {!answers && item.output !== undefined && (
            <JsonBlock value={item.output} className="mt-1.5" />
          )}
        </div>
      )}
    </ToolCardShell>
  );
}
