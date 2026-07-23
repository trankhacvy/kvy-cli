import { HelpCircle } from "lucide-react";
import { parseAskAnswers, parseAskQuestions } from "@/lib/tool-args";
import type { ToolItem } from "@/sync/reducer";
import { AskQuestionOptions } from "../AskQuestionOptions";
import { JsonBlock } from "../JsonBlock";
import { ToolCardShell } from "./ToolCardShell";

const ASK_DECLINED_OUTPUT_MARKERS = [
  "did not answer the structured question form",
  "permission prompt was aborted",
  "doesn't want to proceed with this tool use",
];

function readOutputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const textParts = output
      .map((entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        "text" in entry &&
        (entry as { type?: unknown; text?: unknown }).type === "text" &&
        typeof (entry as { text?: unknown }).text === "string"
          ? (entry as { text: string }).text
          : undefined,
      )
      .filter((entry): entry is string => entry !== undefined);
    return textParts.length > 0 ? textParts.join("\n") : undefined;
  }
  return undefined;
}

function isDeclinedQuestion(item: ToolItem): boolean {
  if (item.permission?.decision?.kind === "deny") return true;
  if (item.ok !== false) return false;
  const outputText = readOutputText(item.output)?.toLowerCase();
  return outputText
    ? ASK_DECLINED_OUTPUT_MARKERS.some((marker) => outputText.includes(marker))
    : false;
}

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
  const declined = isDeclinedQuestion(item);
  const fallbackOutputText = readOutputText(item.output);

  return (
    <ToolCardShell
      item={item}
      icon={<HelpCircle className="size-4 text-muted-foreground" />}
      statusLabel={declined ? "declined" : undefined}
      statusVariant={declined ? "secondary" : undefined}
      toolStateOverride={declined ? "output-available" : undefined}
    >
      {pending ? (
        <p className="text-xs text-muted-foreground">Waiting for an answer…</p>
      ) : declined ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-muted-foreground">User declined to answer questions.</p>
          {questions.map((q) => (
            <div key={q.question} className="flex flex-col gap-0.5">
              <p className="font-medium">{q.question}</p>
              <AskQuestionOptions question={q} />
            </div>
          ))}
          {fallbackOutputText && (
            <p className="text-xs text-muted-foreground">{fallbackOutputText}</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          {questions.map((q) => {
            const answer = answers?.find((a) => a.question === q.question)?.answer;
            return (
              <div key={q.question} className="flex flex-col gap-0.5">
                <p className="font-medium">{q.question}</p>
                <p className="text-muted-foreground">{answer ?? "(no answer recorded)"}</p>
                <AskQuestionOptions question={q} answer={answer} />
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
