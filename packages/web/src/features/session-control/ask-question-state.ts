import type { PermDecision } from "@kvy/wire";
import type { AskQuestionParsed } from "@/lib/tool-args";

/**
 * `AskUserQuestionCard`'s local selection state, kept as pure functions (same
 * "testable without mounting the component" rationale as `perm-card-state.ts`
 * — this package has no component-render test infra, so the logic worth unit
 * testing lives here). One `Set<number>` of selected option
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

/** Clears any selected options for one question — used when the user starts
 * typing a free-text answer for it (mutual exclusion with
 * {@link setAskFreeText}, mirrors the CLI's own "pick an option OR type
 * something" per-question choice). */
export function clearAskSelection(selections: AskSelections, questionIndex: number): AskSelections {
  const next = new Map(selections);
  next.delete(questionIndex);
  return next;
}

/** Per-question free-text answer — set when the user types their own answer
 * instead of picking a listed option (mirrors the CLI's own "Type something"
 * option). A non-empty
 * string for a question always wins over that question's option selections
 * in {@link buildAskAnswers}/{@link allAskQuestionsAnswered}. */
export type AskFreeTextAnswers = Map<number, string>;

/** Sets (or, for an empty string, clears) question `questionIndex`'s
 * free-text answer. */
export function setAskFreeText(
  freeText: AskFreeTextAnswers,
  questionIndex: number,
  text: string,
): AskFreeTextAnswers {
  const next = new Map(freeText);
  if (text.length > 0) next.set(questionIndex, text);
  else next.delete(questionIndex);
  return next;
}

/** True once every question has either a selected option or a non-empty
 * free-text answer — gates the submit button (a multi-question form submits
 * all answers atomically). */
export function allAskQuestionsAnswered(
  questions: AskQuestionParsed[],
  selections: AskSelections,
  freeText: AskFreeTextAnswers = new Map(),
): boolean {
  return questions.every(
    (_, qi) => (selections.get(qi)?.size ?? 0) > 0 || Boolean(freeText.get(qi)),
  );
}

/** Builds the `{question: "label, label"}` (or `{question: "typed text"}`)
 * answers map the bridge's `composeAskAnswerReason` expects on the CLI side
 * — a question's free-text answer, if any, wins over its option selections
 * (joined by ", " for a multi-select question's several selected labels). */
export function buildAskAnswers(
  questions: AskQuestionParsed[],
  selections: AskSelections,
  freeText: AskFreeTextAnswers = new Map(),
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((q, qi) => {
    const free = freeText.get(qi);
    if (free) {
      answers[q.question] = free;
      return;
    }
    const labels = [...(selections.get(qi) ?? [])]
      .map((oi) => q.options[oi]?.label)
      .filter((label): label is string => Boolean(label))
      .join(", ");
    answers[q.question] = labels;
  });
  return answers;
}

/** The exact wire shape a submitted answer takes: `{kind:"allow",
 * scope:"once", updatedInput:{answers}}` — the bridge's
 * `mapDecision` question branch reads `updatedInput.answers` to compose the
 * deny-with-answer reason. */
export function buildAskAnswerDecision(
  questions: AskQuestionParsed[],
  selections: AskSelections,
  freeText: AskFreeTextAnswers = new Map(),
): PermDecision {
  return {
    kind: "allow",
    scope: "once",
    updatedInput: { answers: buildAskAnswers(questions, selections, freeText) },
  };
}

/** "Chat about this" — declines the
 * structured question form outright, mirroring the CLI's own "Chat about
 * this" option. Deliberately carries no `message`: the bridge's `mapDecision`
 * falls back to `ASK_FALLBACK_REASON` for a message-less deny, which already
 * instructs the model to drop the structured form and ask again in plain
 * text — exactly the behavior we want here, so there's no separate reason
 * string to keep in sync on the web side. */
export function buildChatAboutThisDecision(): PermDecision {
  return { kind: "deny" };
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
