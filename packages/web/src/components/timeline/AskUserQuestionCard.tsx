"use client";

import type { PermDecision } from "@kvy/wire";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type AskFreeTextAnswers,
  type AskSelections,
  allAskQuestionsAnswered,
  applyAnswerResult,
  buildAskAnswerDecision,
  buildChatAboutThisDecision,
  clearAskSelection,
  extractAskAnswers,
  fromError,
  type PermCardPhase,
  setAskFreeText,
  toggleAskSelection,
  useSessionControl,
} from "@/features/session-control";
import { type AskQuestionParsed, parseAskQuestions } from "@/lib/tool-args";
import { cn } from "@/lib/utils";
import type { PermissionInfo } from "@/sync/reducer";
import { AskQuestionOptions } from "./AskQuestionOptions";

export function AskUserQuestionCard({
  args,
  permission,
}: {
  args: unknown;
  permission: PermissionInfo;
}) {
  const { actions } = useSessionControl();
  const questions = parseAskQuestions(args);
  const [selections, setSelections] = useState<AskSelections>(new Map());
  const [freeText, setFreeText] = useState<AskFreeTextAnswers>(new Map());
  const [phase, setPhase] = useState<PermCardPhase>({ kind: "idle" });

  const mutation = useMutation({
    mutationFn: (decision: PermDecision) => actions.answerPermission(permission.reqId, decision),
  });

  // Same "canonical decision always wins" rule as `PermCard` — once the
  // reducer has a `perm-resolve`-derived decision, it's authoritative
  // regardless of this card's own optimistic phase.
  if (permission.decision || phase.kind === "answered" || phase.kind === "lost-race") {
    return <AskAnsweredSummary questions={questions} permission={permission} phase={phase} />;
  }

  // A locally-typed terminal turn's question (`answerable: false`) has no
  // channel for a web click to drive it — the human at the keyboard answers
  // Claude Code's own question widget there. Rendering Submit/Chat-about-this
  // buttons here would be a false affordance; the card resolves on its own
  // once the reducer's `permission.decision` catches up from that terminal
  // answer. `phase.kind === "not-answerable"` covers a click that slipped
  // through anyway (e.g. an older CLI build that doesn't yet send
  // `answerable`) and the CLI told us so after the fact.
  if (permission.answerable === false || phase.kind === "not-answerable") {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-sky-500/40 bg-sky-500/5 px-3 py-2 text-sm">
        {questions.map((q) => (
          <div key={q.question} className="flex flex-col gap-1.5">
            {q.header && (
              <Badge variant="secondary" className="w-fit">
                {q.header}
              </Badge>
            )}
            <p className="font-medium">{q.question}</p>
            <AskQuestionOptions question={q} />
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          Waiting for a response at the terminal. This can't be answered from the web.
        </p>
      </div>
    );
  }

  const toggle = (qi: number, oi: number, multi: boolean) => {
    setSelections((prev) => toggleAskSelection(prev, qi, oi, multi));
    setFreeText((prev) => setAskFreeText(prev, qi, ""));
  };

  const onFreeTextChange = (qi: number, text: string) => {
    setFreeText((prev) => setAskFreeText(prev, qi, text));
    if (text.length > 0) setSelections((prev) => clearAskSelection(prev, qi));
  };

  const allAnswered = allAskQuestionsAnswered(questions, selections, freeText);
  const submitting = phase.kind === "submitting" || mutation.isPending;

  const runMutation = (decision: PermDecision) => {
    setPhase({ kind: "submitting", decision });
    mutation.mutate(decision, {
      onSuccess: (result) => setPhase(applyAnswerResult(decision, result)),
      onError: (error) => setPhase(fromError(error)),
    });
  };

  const submit = () => runMutation(buildAskAnswerDecision(questions, selections, freeText));
  const chatAboutThis = () => runMutation(buildChatAboutThisDecision());

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-sky-500/40 bg-sky-500/5 px-3 py-2 text-sm">
      {questions.map((q, qi) => (
        <div key={q.question} className="flex flex-col gap-1.5">
          {q.header && (
            <Badge variant="secondary" className="w-fit">
              {q.header}
            </Badge>
          )}
          <p className="font-medium">{q.question}</p>
          <div className="flex flex-col gap-1">
            {q.options.map((opt, oi) => {
              const selected = selections.get(qi)?.has(oi) ?? false;
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => toggle(qi, oi, q.multiSelect ?? false)}
                  className={cn(
                    "rounded-md border px-2.5 py-1.5 text-left",
                    selected ? "border-sky-500 bg-sky-500/10" : "border-border hover:bg-muted",
                  )}
                >
                  <span>{opt.label}</span>
                  {opt.description && (
                    <span className="block text-xs text-muted-foreground">{opt.description}</span>
                  )}
                </button>
              );
            })}
          </div>
          <Input
            value={freeText.get(qi) ?? ""}
            onChange={(e) => onFreeTextChange(qi, e.target.value)}
            placeholder="Or type your own answer…"
            className="h-8 text-sm"
          />
        </div>
      ))}

      {phase.kind === "error" && <p className="text-xs text-destructive">{phase.message}</p>}

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!allAnswered || submitting} onClick={submit}>
          Submit answer{questions.length > 1 ? "s" : ""}
        </Button>
        <Button size="sm" variant="outline" disabled={submitting} onClick={chatAboutThis}>
          Chat about this instead
        </Button>
      </div>
    </div>
  );
}

/** Read-only view once the question is answered (either by us, winning the
 * first-wins race, or by another device — `phase.kind === "lost-race"`). */
function AskAnsweredSummary({
  questions,
  permission,
  phase,
}: {
  questions: AskQuestionParsed[];
  permission: PermissionInfo;
  phase: PermCardPhase;
}) {
  const decision =
    permission.decision ??
    (phase.kind === "answered" || phase.kind === "lost-race" ? phase.decision : undefined);
  const answers = extractAskAnswers(decision);
  const denied = decision?.kind === "deny";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-sky-500/40 bg-sky-500/5 px-3 py-2 text-sm">
      {phase.kind === "lost-race" && (
        <Badge variant="secondary" className="w-fit">
          Answered on another device
        </Badge>
      )}
      {questions.map((q) => (
        <div key={q.question} className="flex flex-col gap-0.5">
          <p className="font-medium">{q.question}</p>
          <p className="text-muted-foreground">
            {answers?.[q.question] ??
              (denied ? "Not answered" : decision ? "(no answer recorded)" : "Awaiting answer…")}
          </p>
          <AskQuestionOptions question={q} answer={answers?.[q.question]} />
        </div>
      ))}
    </div>
  );
}
