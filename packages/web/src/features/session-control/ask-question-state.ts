import type { PermDecision } from "@falcon/wire";
import type { AskQuestionParsed } from "@/lib/tool-args";

/**
 * `AskUserQuestionCard`'s local selection state, kept as pure functions (same
 * "testable without mounting the component" rationale as `perm-card-state.ts`
 * — this package has no component-render test infra, so the logic worth unit
 * testing lives here, plan-v2.md W2.1). One `Set<number>` of selected option
 * indices per question index; a single-select question's set never grows
 * past size 1 (see {@link toggleAskSelection}).
 */
export type AskSelections = Map<number, Set<number>>;

/** Toggles one option. Single-select questions (`multi=false`) replace
 * whatever was selected; multi-select questions accumulate/remove. */
export function toggleAskSelection(
  selections: AskSelections,
  questionIndex: number,
  optionIndex: number,
  multi: boolean,
): AskSelections {
  const next = new Map(selections);
  const current = new Set(multi ? (next.get(questionIndex) ?? []) : []);
  if (current.has(optionIndex)) current.delete(optionIndex);
  else current.add(optionIndex);
  next.set(questionIndex, current);
  return next;
}

/** True once every question has at least one selected option — gates the
 * submit button (a multi-question form submits all answers atomically). */
export function allAskQuestionsAnswered(
  questions: AskQuestionParsed[],
  selections: AskSelections,
): boolean {
  return questions.every((_, qi) => (selections.get(qi)?.size ?? 0) > 0);
}

/** Builds the `{question: "label, label"}` answers map the bridge's
 * `composeAskAnswerReason` expects on the CLI side (joined by ", " for a
 * multi-select question's several selected labels). */
export function buildAskAnswers(
  questions: AskQuestionParsed[],
  selections: AskSelections,
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((q, qi) => {
    const labels = [...(selections.get(qi) ?? [])]
      .map((oi) => q.options[oi]?.label)
      .filter((label): label is string => Boolean(label))
      .join(", ");
    answers[q.question] = labels;
  });
  return answers;
}

/** The exact wire shape a submitted answer takes: `{kind:"allow",
 * scope:"once", updatedInput:{answers}}` (plan-v2.md W2.1 — the bridge's
 * `mapDecision` question branch reads `updatedInput.answers` to compose the
 * deny-with-answer reason). */
export function buildAskAnswerDecision(
  questions: AskQuestionParsed[],
  selections: AskSelections,
): PermDecision {
  return {
    kind: "allow",
    scope: "once",
    updatedInput: { answers: buildAskAnswers(questions, selections) },
  };
}

/** Reads back the answers map from a `PermDecision` that came from either
 * the canonical `permission.decision` (reducer-authoritative) or this card's
 * own optimistic `phase.decision` — used by the answered/lost-race summary.
 * `undefined` for any decision that isn't a `buildAskAnswerDecision`-shaped
 * allow (e.g. a plain deny, or an allow with no `answers`). */
export function extractAskAnswers(decision?: PermDecision): Record<string, string> | undefined {
  if (decision?.kind !== "allow") return undefined;
  const updated = decision.updatedInput;
  if (typeof updated !== "object" || updated === null || Array.isArray(updated)) return undefined;
  const answers = (updated as Record<string, unknown>).answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return undefined;
  return answers as Record<string, string>;
}
