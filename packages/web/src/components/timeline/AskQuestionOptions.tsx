import type { AskQuestionParsed } from "@/lib/tool-args";
import { cn } from "@/lib/utils";

function selectedLabels(answer?: string): Set<string> {
  if (!answer) return new Set();
  return new Set(
    answer
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label.length > 0),
  );
}

export function AskQuestionOptions({
  question,
  answer,
}: {
  question: AskQuestionParsed;
  answer?: string;
}) {
  if (question.options.length === 0) return null;

  const selected = selectedLabels(answer);

  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {question.options.map((option) => {
        const isSelected = selected.has(option.label);
        return (
          <span
            key={option.label}
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs",
              isSelected
                ? "border-sky-500/60 bg-sky-500/10 text-foreground"
                : "border-border/70 bg-muted/30 text-muted-foreground",
            )}
          >
            {option.label}
          </span>
        );
      })}
    </div>
  );
}
