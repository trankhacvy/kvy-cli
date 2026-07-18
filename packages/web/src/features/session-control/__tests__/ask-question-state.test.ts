import { describe, expect, it } from "vitest";
import type { AskQuestionParsed } from "@/lib/tool-args";
import {
  type AskSelections,
  allAskQuestionsAnswered,
  buildAskAnswerDecision,
  buildAskAnswers,
  extractAskAnswers,
  toggleAskSelection,
} from "../ask-question-state";

const singleSelectQuestion: AskQuestionParsed = {
  question: "Which color?",
  options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
};

const multiSelectQuestion: AskQuestionParsed = {
  question: "Which frameworks?",
  multiSelect: true,
  options: [{ label: "React" }, { label: "Vue" }, { label: "Svelte" }],
};

describe("toggleAskSelection", () => {
  it("selects a single-select option, replacing any prior selection", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, false);
    expect(selections.get(0)).toEqual(new Set([0]));

    selections = toggleAskSelection(selections, 0, 1, false);
    expect(selections.get(0)).toEqual(new Set([1])); // replaced, not accumulated
  });

  it("re-picking the same single-select option twice leaves it selected", () => {
    // A single-select toggle always starts from a fresh empty set (radio-
    // button semantics — the prior pick is discarded regardless of which
    // option it was), so re-toggling the *same* index re-adds it rather
    // than deselecting it. This mirrors plan-v2.md's own reference snippet.
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, false);
    selections = toggleAskSelection(selections, 0, 0, false);
    expect(selections.get(0)).toEqual(new Set([0]));
  });

  it("accumulates multi-select options", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, true);
    selections = toggleAskSelection(selections, 0, 2, true);
    expect(selections.get(0)).toEqual(new Set([0, 2]));
  });

  it("removes one multi-select option without touching the others", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, true);
    selections = toggleAskSelection(selections, 0, 1, true);
    selections = toggleAskSelection(selections, 0, 0, true);
    expect(selections.get(0)).toEqual(new Set([1]));
  });

  it("does not mutate the input map (pure function)", () => {
    const selections: AskSelections = new Map();
    const next = toggleAskSelection(selections, 0, 0, false);
    expect(selections.size).toBe(0);
    expect(next.size).toBe(1);
  });

  it("keeps other questions' selections untouched", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, false);
    selections = toggleAskSelection(selections, 1, 1, true);
    expect(selections.get(0)).toEqual(new Set([0]));
    expect(selections.get(1)).toEqual(new Set([1]));
  });
});

describe("allAskQuestionsAnswered", () => {
  it("is false until every question has a selection", () => {
    const questions = [singleSelectQuestion, multiSelectQuestion];
    let selections: AskSelections = new Map();
    expect(allAskQuestionsAnswered(questions, selections)).toBe(false);

    selections = toggleAskSelection(selections, 0, 0, false);
    expect(allAskQuestionsAnswered(questions, selections)).toBe(false);

    selections = toggleAskSelection(selections, 1, 0, true);
    expect(allAskQuestionsAnswered(questions, selections)).toBe(true);
  });

  it("is true for an empty question list", () => {
    expect(allAskQuestionsAnswered([], new Map())).toBe(true);
  });
});

describe("buildAskAnswers / buildAskAnswerDecision", () => {
  it("builds a single label per single-select question", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 1, false);
    expect(buildAskAnswers([singleSelectQuestion], selections)).toEqual({
      "Which color?": "Blue",
    });
  });

  it("joins multiple selected labels with ', ' for a multi-select question", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, true);
    selections = toggleAskSelection(selections, 0, 2, true);
    expect(buildAskAnswers([multiSelectQuestion], selections)).toEqual({
      "Which frameworks?": "React, Svelte",
    });
  });

  it("buildAskAnswerDecision wraps the answers in the exact wire shape", () => {
    let selections: AskSelections = new Map();
    selections = toggleAskSelection(selections, 0, 0, false);
    expect(buildAskAnswerDecision([singleSelectQuestion], selections)).toEqual({
      kind: "allow",
      scope: "once",
      updatedInput: { answers: { "Which color?": "Red" } },
    });
  });
});

describe("extractAskAnswers", () => {
  it("reads the answers map back out of a matching allow decision", () => {
    expect(
      extractAskAnswers({
        kind: "allow",
        scope: "once",
        updatedInput: { answers: { "Which color?": "Blue" } },
      }),
    ).toEqual({ "Which color?": "Blue" });
  });

  it("returns undefined for a deny decision", () => {
    expect(extractAskAnswers({ kind: "deny", message: "no" })).toBeUndefined();
  });

  it("returns undefined for an allow decision with no updatedInput", () => {
    expect(extractAskAnswers({ kind: "allow", scope: "once" })).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(extractAskAnswers(undefined)).toBeUndefined();
  });
});
